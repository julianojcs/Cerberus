import fp from 'fastify-plugin';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyInstance } from 'fastify';
import {
  AgentChannel,
  bridgeIngestTopic,
  messageSchema,
  parseAgentTopic,
  positionSampleSchema,
} from '@cerberus/shared';
import { MessageModel, Position } from '../models/index.js';

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
        await persistPosition(operationId, agentId, raw);
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

async function persistPosition(operationId: string, agentId: string, raw: unknown): Promise<void> {
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
