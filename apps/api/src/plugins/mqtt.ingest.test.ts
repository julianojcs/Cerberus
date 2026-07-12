import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyInstance } from 'fastify';
import { agentPositionTopic } from '@cerberus/shared';

/**
 * Teste de integração da PONTE MQTT (ingest). Sobe um broker in-process (aedes),
 * conecta a API real (`withMqtt: true`) e publica uma posição no tópico do agente.
 * Valida o coração da fatia vertical: a telemetria `{ lat, lng }` do agente é
 * transposta para GeoJSON `[lng, lat]` e persistida no MongoDB. Determinístico:
 * MongoDB em memória + broker local, sem dependência de rede.
 */
const PORT = 18831;
const operationId = 'op-ingest-test';
const agentId = 'AG-0456';

let broker: Awaited<ReturnType<typeof Aedes.createBroker>>;
let server: Server;
let app: FastifyInstance;
let pub: MqttClient;
// Importados dinamicamente após configurar o env (padrão dos testes da API).
let Position: (typeof import('../models/index.js'))['Position'];
let Geofence: (typeof import('../models/index.js'))['Geofence'];
let Alert: (typeof import('../models/index.js'))['Alert'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('timeout aguardando condição');
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('timeout aguardando resultado');
}

beforeAll(async () => {
  broker = await Aedes.createBroker();
  server = createServer(broker.handle);
  await new Promise<void>((res) => server.listen(PORT, res));

  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongod.getUri('cerberus_db');
  process.env.MQTT_BROKER_URL = `mqtt://127.0.0.1:${PORT}`;
  process.env.JWT_SECRET = 'test_secret_1234567890';

  const { buildApp } = await import('../app.js');
  ({ Position, Geofence, Alert } = await import('../models/index.js'));

  app = await buildApp({ withMqtt: true });

  // Aguarda a ponte da API conectar e assinar o tópico de ingest antes de publicar.
  await waitUntil(() => app.mqtt.connected, 5000);
  await sleep(250);

  pub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'fake-agent-test' });
  await new Promise<void>((res) => pub.once('connect', () => res()));

  // Guardamos o mongod para encerrar no afterAll.
  (globalThis as Record<string, unknown>).__mongod = mongod;
}, 60_000);

afterAll(async () => {
  if (pub) await new Promise<void>((res) => pub.end(false, {}, () => res()));
  await app?.close();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  if (broker) await new Promise<void>((res) => broker.close(() => res()));
  const mongod = (globalThis as Record<string, unknown>).__mongod as
    { stop: () => Promise<unknown> } | undefined;
  await mongod?.stop();
});

describe('ponte MQTT (ingest de telemetria)', () => {
  it('persiste posição publicada transpondo {lat,lng} para GeoJSON [lng,lat]', async () => {
    const lat = -19.9319;
    const lng = -43.9386;

    pub.publish(
      agentPositionTopic(operationId, agentId),
      JSON.stringify({ lat, lng, accuracy: 8, capturedAt: new Date().toISOString() }),
      { qos: 1 },
    );

    const doc = await waitFor(() => Position.findOne({ operationId, agentId }).lean(), 8000);

    expect(doc.location?.type).toBe('Point');
    // Transposição correta: eixo X (lng) antes do Y (lat).
    expect(doc.location?.coordinates).toEqual([lng, lat]);
    expect(doc.capturedAt).toBeInstanceOf(Date);
    // receivedAt é gerado no servidor no momento da ingestão.
    expect(doc.receivedAt).toBeInstanceOf(Date);
  }, 15_000);

  it('não duplica alertas ao descarregar várias posições dentro da zona (buffer flush)', async () => {
    // Zona ativa; um agente publica N posições DENTRO dela numa rajada (simula a
    // descarga do buffer offline: dezenas de posições concorrentes de uma vez).
    const center = { lng: -43.94, lat: -19.95 };
    const burstAgent = 'AG-BURST';
    await Geofence.create({
      operationId,
      name: 'Zona Rajada',
      center: { type: 'Point', coordinates: [center.lng, center.lat] },
      radiusMeters: 200,
      active: true,
    });

    const N = 20;
    for (let i = 0; i < N; i++) {
      pub.publish(
        agentPositionTopic(operationId, burstAgent),
        JSON.stringify({
          lat: center.lat,
          lng: center.lng,
          accuracy: 5,
          capturedAt: new Date(Date.now() + i).toISOString(),
        }),
        { qos: 1 },
      );
    }

    // Espera as N posições serem persistidas e a fila drenar.
    await waitFor(async () => {
      const count = await Position.countDocuments({ operationId, agentId: burstAgent });
      return count >= N ? count : null;
    }, 10000);
    await sleep(800);

    // Sem serialização, cada posição concorrente veria "estava fora" e dispararia
    // um `enter` → dezenas. Com a fila por agente: exatamente UMA entrada.
    const enters = await Alert.countDocuments({
      operationId,
      agentId: burstAgent,
      type: 'enter',
    });
    expect(enters).toBe(1);
  }, 20_000);
});
