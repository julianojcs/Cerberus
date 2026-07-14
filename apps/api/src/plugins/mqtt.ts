import fp from 'fastify-plugin';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyInstance } from 'fastify';
import {
  AgentChannel,
  bridgeIngestTopic,
  messageSchema,
  operationBroadcastTopic,
  parseAgentTopic,
  positionSampleSchema,
} from '@cerberus/shared';
import {
  Alert,
  Geofence,
  GeofenceMembership,
  MessageModel,
  Position,
  Team,
} from '../models/index.js';
import { detectGeofenceEvents, type GeofenceLike } from '../modules/geofences/detect.js';

/**
 * Fila de serialização POR AGENTE. Os handlers de mensagem do MQTT são assíncronos
 * e rodam concorrentemente; quando o buffer offline do app descarrega dezenas de
 * posições de uma vez, TODAS entram ao mesmo tempo. Sem serializar, cada uma lê o
 * MESMO estado de pertencimento (memberships) ANTES de qualquer outra gravar — todas
 * veem "estava fora" e disparam `enter`, gerando dezenas de alertas duplicados. A
 * fila garante o ciclo ler→decidir→gravar atômico e em ordem cronológica por agente
 * (agentes distintos seguem em paralelo).
 */
const agentQueue = new Map<string, Promise<unknown>>();
function serializePerAgent(key: string, task: () => Promise<void>): Promise<void> {
  const prev = agentQueue.get(key) ?? Promise.resolve();
  const run = prev.then(task); // encadeia após o anterior (prev nunca rejeita, ver abaixo)
  agentQueue.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * PONTE MQTT (ingest). A API conecta ao broker como cliente privilegiado,
 * assina `operacao/+/agente/+/#` e persiste posições e mensagens no MongoDB.
 * Isso desacopla a escrita no banco da plotagem em tempo real (dashboard assina
 * o broker diretamente, evitando gargalo no banco — conforme a especificação).
 */
export default fp(async function mqttPlugin(app: FastifyInstance) {
  const { MQTT_BROKER_URL, MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD } = app.env;

  const client: MqttClient = mqtt.connect(MQTT_BROKER_URL, {
    clientId: `${MQTT_CLIENT_ID}_${process.pid}`,
    username: MQTT_USERNAME || undefined,
    password: MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
    clean: true,
  });

  client.on('connect', () => {
    app.log.info('MQTT bridge connected to broker');
    const topic = bridgeIngestTopic();
    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) app.log.error({ err }, 'Failed to subscribe to ingest topic');
      else app.log.info(`MQTT bridge subscribed to ${topic}`);
    });
  });

  client.on('reconnect', () => app.log.warn('MQTT bridge reconnecting...'));
  client.on('error', (err) => app.log.error({ err }, 'MQTT bridge error'));

  client.on('message', async (topic, payload) => {
    const parsed = parseAgentTopic(topic);
    if (!parsed) return; // ignora tópicos fora do padrão de agente
    const { operationId, agentId, channel } = parsed;

    try {
      const raw = JSON.parse(payload.toString());
      if (channel === AgentChannel.POSICAO) {
        // Serializa persistência + geofencing por agente (evita alertas duplicados
        // quando o buffer offline descarrega várias posições concorrentes).
        await serializePerAgent(`${operationId}:${agentId}`, async () => {
          const sample = await persistPosition(operationId, agentId, raw);
          await checkGeofences(app, client, operationId, agentId, sample);
        });
      } else if (channel === AgentChannel.MENSAGEM) {
        await persistMessage(operationId, agentId, raw);
      }
    } catch (err) {
      app.log.warn({ err, topic }, 'Invalid MQTT payload — discarded');
    }
  });

  app.decorate('mqtt', client);
  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  });
});

async function persistPosition(
  operationId: string,
  agentId: string,
  raw: unknown,
): Promise<{ lng: number; lat: number; capturedAt: string }> {
  const sample = positionSampleSchema.parse(raw);
  await Position.create({
    operationId,
    agentId,
    location: { type: 'Point', coordinates: [sample.lng, sample.lat] },
    accuracy: sample.accuracy,
    altitude: sample.altitude,
    speed: sample.speed ?? undefined,
    heading: sample.heading ?? undefined,
    battery: sample.battery,
    activity: sample.activity,
    capturedAt: new Date(sample.capturedAt),
    receivedAt: new Date(),
  });
  return { lng: sample.lng, lat: sample.lat, capturedAt: sample.capturedAt };
}

/**
 * Geofencing: após persistir a posição, compara-a com o ESTADO ANTERIOR de
 * pertencimento (membership) contra as zonas ativas da operação. Só a TRANSIÇÃO
 * (fora→dentro / dentro→fora) vira um Alert persistido + anúncio no broadcast;
 * ficar parado dentro de uma zona NÃO repete alerta.
 */
async function checkGeofences(
  app: FastifyInstance,
  client: MqttClient,
  operationId: string,
  agentId: string,
  sample: { lng: number; lat: number; capturedAt: string },
): Promise<void> {
  // Cast: typing lean do Mongoose p/ vertices não casa com GeofenceLike (dados OK em runtime).
  const geofences = (await Geofence.find({ operationId, active: true })
    .lean()) as unknown as GeofenceLike[];
  if (geofences.length === 0) return;

  // Estado anterior de pertencimento por zona (fonte de verdade, não a posição anterior).
  const memberships = await GeofenceMembership.find({ operationId, agentId }).lean();
  const insideBefore: Record<string, boolean> = {};
  for (const m of memberships) insideBefore[m.geofenceId] = m.inside;

  // Fase 5b — contexto: equipes do agente (só se houver zona por equipe) + hora UTC.
  const hasTeamZone = geofences.some((g) => g.teamId);
  const agentTeamIds = hasTeamZone
    ? (await Team.find({ operationId, agentIds: agentId }).select('_id').lean()).map((t) =>
        String(t._id),
      )
    : [];
  const capturedDate = new Date(sample.capturedAt);
  const atUtcMin = capturedDate.getUTCHours() * 60 + capturedDate.getUTCMinutes();

  const events = detectGeofenceEvents(
    { lng: sample.lng, lat: sample.lat },
    insideBefore,
    geofences,
    { atUtcMin, agentTeamIds },
  );
  for (const ev of events) {
    // Atualiza o estado ANTES de anunciar (idempotência sob concorrência) — sempre,
    // mesmo quando a zona não alerta nesta transição (regra enter/exit).
    await GeofenceMembership.updateOne(
      { operationId, agentId, geofenceId: ev.geofenceId },
      { $set: { inside: ev.inside, updatedAt: new Date() } },
      { upsert: true },
    );
    if (!ev.notify) continue; // zona só-entrada/só-saída: transição oposta não alerta
    await Alert.create({
      operationId,
      agentId,
      geofenceId: ev.geofenceId,
      geofenceName: ev.geofenceName,
      type: ev.type,
      severity: ev.severity,
      location: { type: 'Point', coordinates: [sample.lng, sample.lat] },
      capturedAt: new Date(sample.capturedAt),
      receivedAt: new Date(),
    });
    app.log.info(
      { operationId, agentId, geofence: ev.geofenceName, type: ev.type },
      'Geofence event',
    );
    if (client.connected) {
      const verb = ev.type === 'enter' ? 'entrou em' : 'saiu de';
      client.publish(
        operationBroadcastTopic(operationId),
        JSON.stringify({
          senderId: 'GEOFENCE',
          type: 'alert',
          text: `${agentId} ${verb} ${ev.geofenceName}`,
          capturedAt: sample.capturedAt,
        }),
        { qos: 1 },
      );
    }
  }
}

async function persistMessage(operationId: string, senderId: string, raw: unknown): Promise<void> {
  // No tópico o senderId é o agentId; validamos o restante do payload.
  const msg = messageSchema.parse({ ...(raw as object), operationId, senderId });
  await MessageModel.create({
    operationId,
    senderId,
    type: msg.type,
    text: msg.text,
    ciphertext: msg.ciphertext,
    mediaRef: msg.mediaRef,
    capturedAt: new Date(msg.capturedAt),
    receivedAt: new Date(),
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    mqtt: MqttClient;
  }
}
