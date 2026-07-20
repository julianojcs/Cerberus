import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyInstance } from 'fastify';
import { Role, parseAgentTopic, positionSampleSchema } from '@cerberus/shared';

/**
 * Integração do CONTROLE DA SIMULAÇÃO (issue #134). Sobe broker in-process (aedes) +
 * Mongo em memória, chama os endpoints via `app.inject()` e observa, num assinante MQTT,
 * as posições/presença que a API publica. Cobre o mecanismo (iniciar → publica; pausar →
 * silêncio; parar → offline) E as três travas (flag, nome da operação, papel).
 */
const PORT = 18836;

let broker: Awaited<ReturnType<typeof Aedes.createBroker>>;
let server: Server;
let app: FastifyInstance;
let sub: MqttClient;
let simOpId: string;
let realOpId: string;
let adminToken: string;
let agentToken: string;

const positions: { agentId: string }[] = [];
const status: { agentId: string; online: boolean }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('timeout aguardando condição');
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
  process.env.SIMULATION_ENABLED = 'true';
  // OSRM numa porta morta: a conexão falha na hora e o motor cai no traçado reto entre
  // os waypoints. Mantém o teste DETERMINÍSTICO e sem rede (regra de testes).
  process.env.OSRM_BASE_URL = 'http://127.0.0.1:9';

  const { buildApp } = await import('../../app.js');
  const { Operation } = await import('../../models/index.js');
  const { SIM_OPERATION_NAME } = await import('./roster.js');

  app = await buildApp({ withMqtt: true });
  await waitUntil(() => app.mqtt.connected, 5000);

  const simOp = await Operation.create({
    name: SIM_OPERATION_NAME,
    type: 'escolta',
    status: 'ativa',
  });
  const realOp = await Operation.create({
    name: 'Operação Real',
    type: 'escolta',
    status: 'ativa',
  });
  simOpId = String(simOp._id);
  realOpId = String(realOp._id);

  adminToken = app.jwt.sign({ sub: 'admin1', role: Role.ADMIN, operationIds: [simOpId, realOpId] });
  agentToken = app.jwt.sign({
    sub: 'agent1',
    role: Role.AGENTE,
    agentId: 'AG-SIM-01',
    operationIds: [simOpId],
  });

  // Assinante que observa o que a API publica.
  sub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'observer-test' });
  await new Promise<void>((res) => sub.once('connect', () => res()));
  await new Promise<void>((res) => sub.subscribe(`operacao/${simOpId}/#`, () => res()));
  sub.on('message', (topic, payload) => {
    const parsed = parseAgentTopic(topic);
    if (!parsed) return;
    const raw: unknown = JSON.parse(payload.toString());
    if (parsed.channel === 'posicao' && positionSampleSchema.safeParse(raw).success) {
      positions.push({ agentId: parsed.agentId });
    }
    if (parsed.channel === 'status') {
      status.push({ agentId: parsed.agentId, online: (raw as { online: boolean }).online });
    }
  });

  (globalThis as Record<string, unknown>).__mongod = mongod;
}, 60_000);

afterAll(async () => {
  // Garante que nenhum laço fique vivo (o onClose do módulo também limpa).
  await app?.inject({
    method: 'POST',
    url: `/operations/${simOpId}/simulation/stop`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (sub) await new Promise<void>((res) => sub.end(false, {}, () => res()));
  await app?.close();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  if (broker) await new Promise<void>((res) => broker.close(() => res()));
  const mongod = (globalThis as Record<string, unknown>).__mongod as
    { stop: () => Promise<unknown> } | undefined;
  await mongod?.stop();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('controle da simulação — mecanismo', () => {
  it('inicia, publica presença online e passa a publicar posições', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${simOpId}/simulation/start`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ running: true, paused: false });
    expect(res.json().agentIds.length).toBeGreaterThan(0);

    // Presença online de todos os agentes + posições fluindo (tick de 2 s).
    await waitUntil(() => status.some((s) => s.online), 8000);
    await waitUntil(() => positions.length >= 2, 12_000);
    expect(positions.length).toBeGreaterThan(0);
  }, 20_000);

  it('pausa: as posições PARAM de chegar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${simOpId}/simulation/pause`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: true, paused: true });

    await sleep(500); // deixa terminar um tick em voo
    const count = positions.length;
    await sleep(4500); // > 2 ticks — nada novo deve chegar
    expect(positions.length).toBe(count);
  }, 15_000);

  it('para: publica offline e zera o estado', async () => {
    const before = status.filter((s) => !s.online).length;
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${simOpId}/simulation/stop`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: false });

    await waitUntil(() => status.filter((s) => !s.online).length > before, 5000);
  }, 10_000);
});

describe('controle da simulação — travas de segurança', () => {
  it('recusa operação que não é SIMULAÇÃO (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${realOpId}/simulation/start`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('recusa papel de agente (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${simOpId}/simulation/start`,
      headers: auth(agentToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sem token, 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/operations/${simOpId}/simulation` });
    expect(res.statusCode).toBe(401);
  });

  it('GET status autorizado responde 200 com o formato esperado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${simOpId}/simulation`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: false, paused: false });
    expect(Array.isArray(res.json().agentIds)).toBe(true);
  });
});
