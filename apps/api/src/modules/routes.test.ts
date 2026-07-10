import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

/**
 * Testes de integração das rotas Fastify via `app.inject()` (sem abrir portas
 * TCP). Persistência isolada em MongoDB em memória (não polui o banco dev) e a
 * ponte MQTT desligada (`withMqtt: false`) — evita dependência de rede/broker.
 */
let mongod: MongoMemoryServer;
let app: FastifyInstance;
let operationId: string;
let token: string;
let agentToken: string;
let assignUserId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongod.getUri('cerberus_db');
  process.env.MQTT_BROKER_URL = 'mqtt://localhost:1883'; // exigido pelo env; não conecta
  process.env.JWT_SECRET = 'test_secret_1234567890';

  const { buildApp } = await import('../app.js');
  const { User, Operation, Position } = await import('../models/index.js');

  app = await buildApp({ withMqtt: false });

  const op = await Operation.create({ name: 'Op Teste', type: 'escolta', status: 'ativa' });
  operationId = String(op._id);

  await User.create({
    username: 'admin',
    name: 'Central',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'admin',
    operationIds: [op._id],
  });

  await User.create({
    username: 'agente01',
    name: 'Agente de Campo',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'agente',
    agentId: 'AG-0456',
    operationIds: [op._id],
  });
  const outsider = await User.create({
    username: 'agente02',
    name: 'Agente Reserva',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'agente',
    agentId: 'AG-0457',
    operationIds: [],
  });
  assignUserId = String(outsider._id);

  const agentLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'agente01', password: 'cerberus123' },
  });
  agentToken = agentLogin.json().token;

  await Position.create({
    operationId,
    agentId: 'AG-0456',
    location: { type: 'Point', coordinates: [-43.9386, -19.9319] },
    accuracy: 8,
    capturedAt: new Date(),
    receivedAt: new Date(),
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await mongod?.stop();
});

describe('autenticação', () => {
  it('rejeita credenciais inválidas com 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'errada' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('emite JWT em login válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'cerberus123' },
    });
    expect(res.statusCode).toBe(200);
    token = res.json().token;
    expect(token).toBeTruthy();
  });
});

describe('rotas escopadas por operação', () => {
  it('retorna a última posição do agente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/positions/latest`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ agentId: 'AG-0456', lng: -43.9386, lat: -19.9319 });
  });

  it('consulta de proximidade 2dsphere retorna o ponto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/positions/nearby?lng=-43.9386&lat=-19.9319&meters=500`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('bloqueia operação fora do escopo do token com 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/000000000000000000000000/positions/latest`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exige autenticação (401 sem token)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/positions/latest`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('gestão de operações (admin)', () => {
  it('admin atualiza o status da operação (PATCH)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'encerrada' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('encerrada');
  });

  it('agente (não-admin) recebe 403 no PATCH', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: 'ativa' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin atribui um usuário à operação e ele aparece nos membros', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: { userId: assignUserId },
    });
    expect(add.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/members`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const usernames = (list.json() as Array<{ username: string }>).map((u) => u.username);
    expect(usernames).toContain('agente02');
  });

  it('admin remove o usuário da operação (DELETE)', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/operations/${operationId}/members/${assignUserId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/members`,
      headers: { authorization: `Bearer ${token}` },
    });
    const usernames = (list.json() as Array<{ username: string }>).map((u) => u.username);
    expect(usernames).not.toContain('agente02');
  });

  it('bloqueia operação fora do escopo com 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/operations/000000000000000000000000',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'ativa' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('criador entra no escopo após /auth/refresh (resolve o deadlock)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/operations',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Op Criada', type: 'mandado' },
    });
    expect(create.statusCode).toBe(201);
    const newOpId = create.json().id;

    // Token antigo ainda não tem a nova operação no escopo.
    const before = await app.inject({
      method: 'GET',
      url: `/operations/${newOpId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(403);

    // Refresh re-emite o token com o escopo atualizado do banco.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refreshed.statusCode).toBe(200);
    const newToken = refreshed.json().token;
    expect(refreshed.json().user.operationIds).toContain(newOpId);

    // Agora consegue acessar/gerenciar a operação criada.
    const after = await app.inject({
      method: 'GET',
      url: `/operations/${newOpId}`,
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(after.statusCode).toBe(200);
  });
});

describe('provisionamento de usuários (admin)', () => {
  let newUserId: string;

  it('admin cria um agente (POST /users) sem expor passwordHash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        username: 'agente99',
        name: 'Agente Novo',
        password: 'senha123',
        role: 'agente',
        agentId: 'AG-0099',
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    newUserId = created.id;
    expect(created.username).toBe('agente99');
    expect(created.role).toBe('agente');
    expect(created).not.toHaveProperty('passwordHash');
  });

  it('o novo usuário consegue autenticar (senha corretamente hasheada)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'agente99', password: 'senha123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('rejeita nome de usuário duplicado com 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        username: 'agente99',
        name: 'Duplicado',
        password: 'senha123',
        role: 'agente',
        agentId: 'AG-0100',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('exige agentId para agentes (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'semagente', name: 'Sem Agente', password: 'senha123', role: 'agente' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('não-admin recebe 403 ao criar usuário', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        username: 'xyz',
        name: 'X',
        password: 'senha123',
        role: 'agente',
        agentId: 'AG-1',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lista usuários inclui o novo (GET /users)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const usernames = (res.json() as Array<{ username: string }>).map((u) => u.username);
    expect(usernames).toContain('agente99');
  });

  it('admin atualiza o nome (PATCH /users/:id)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${newUserId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Agente Renomeado' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Agente Renomeado');
  });

  it('admin remove o usuário (DELETE /users/:id) e depois 404', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/users/${newUserId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: `/users/${newUserId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(404);
  });
});

describe('mensagens táticas (texto)', () => {
  it('admin envia mensagem (POST) e ela é persistida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Comando: manter posição.' },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Comando: manter posição.');
    expect(msg.senderId).toBeTruthy();
  });

  it('agente envia mensagem com senderId = agentId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { text: 'Alvo avistado.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().senderId).toBe('AG-0456');
  });

  it('histórico lista as mensagens (GET)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const texts = (res.json() as Array<{ text: string }>).map((m) => m.text);
    expect(texts).toContain('Alvo avistado.');
    expect(texts).toContain('Comando: manter posição.');
  });

  it('rejeita texto vazio com 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('bloqueia operação fora do escopo com 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operations/000000000000000000000000/messages',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exige autenticação (401 sem token)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
    });
    expect(res.statusCode).toBe(401);
  });
});
