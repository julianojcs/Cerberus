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
import { Alert, Geofence, MessageModel, Position } from '../models/index.js';
import { detectGeofenceEvents } from '../modules/geofences/detect.js';

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
        const sample = await persistPosition(operationId, agentId, raw);
        await checkGeofences(app, client, operationId, agentId, sample);
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
 * Geofencing: após persistir a posição, compara com a anterior contra as zonas
 * ativas da operação; cada transição enter/exit vira um Alert persistido +
 * anúncio no canal broadcast (agentes/dashboard).
 */
async function checkGeofences(
  app: FastifyInstance,
  client: MqttClient,
  operationId: string,
  agentId: string,
  sample: { lng: number; lat: number; capturedAt: string },
): Promise<void> {
  const geofences = await Geofence.find({ operationId, active: true }).lean();
  if (geofences.length === 0) return;

  const prevDocs = await Position.find({ operationId, agentId })
    .sort({ capturedAt: -1 })
    .skip(1) // pula a posição recém-persistida; pega a anterior
    .limit(1)
    .lean();
  const prevCoords = (prevDocs[0]?.location as { coordinates?: number[] } | undefined)?.coordinates;
  const [plng, plat] = prevCoords ?? [];
  const prev = plng != null && plat != null ? { lng: plng, lat: plat } : null;

  const events = detectGeofenceEvents({ lng: sample.lng, lat: sample.lat }, prev, geofences);
  for (const ev of events) {
    await Alert.create({
      operationId,
      agentId,
      geofenceId: ev.geofenceId,
      geofenceName: ev.geofenceName,
      type: ev.type,
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
