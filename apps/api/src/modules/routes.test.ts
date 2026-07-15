import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';
import {
  decryptBytes,
  encryptBytes,
  generateKeyPair,
  openMessage,
  sealMessage,
} from '@cerberus/shared';

// PNG 1x1 transparente (fixture binária mínima para os testes de mídia).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

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
let saToken: string;

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

  await User.create({
    username: 'superadmin',
    name: 'Super Central',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'superadmin',
    operationIds: [],
  });
  const saLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'superadmin', password: 'cerberus123' },
  });
  saToken = saLogin.json().token;

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

describe('health', () => {
  it('GET /health → 200 com status ok e mongo conectado', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('cerberus-api');
    expect(body.mongo).toBe('connected'); // memory server conectado
    expect(body).toHaveProperty('mqtt'); // ponte desligada nos testes (withMqtt:false)
  });
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

describe('diretório de chaves E2EE', () => {
  const adminKeys = generateKeyPair();
  const agentKeys = generateKeyPair();

  it('registra a chave pública do admin (PUT /auth/public-key) → 200', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: adminKeys.publicKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe(adminKeys.publicKey);
  });

  it('registra a chave pública do agente', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { publicKey: agentKeys.publicKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejeita chave pública malformada (400)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: 'nao-e-base64-de-32-bytes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exige autenticação para registrar (401)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      payload: { publicKey: adminKeys.publicKey },
    });
    expect(res.statusCode).toBe(401);
  });

  it('diretório lista as chaves da operação, com id = agentId para o agente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json() as Array<{ id: string; role: string; publicKey: string }>;
    const agent = entries.find((e) => e.id === 'AG-0456');
    expect(agent?.publicKey).toBe(agentKeys.publicKey);
    expect(agent?.role).toBe('agente');
    // o admin aparece com id = userId (sem agentId)
    expect(entries.some((e) => e.role === 'admin' && e.publicKey === adminKeys.publicKey)).toBe(
      true,
    );
  });

  it('agente também lê o diretório da própria operação (futuro agente→central)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/keys`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('bloqueia o diretório fora do escopo (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operations/000000000000000000000000/keys',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exige autenticação no diretório (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/keys`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('mensagens táticas E2EE (texto)', () => {
  // Chat da operação: cada membro cifra para todos (aqui, para o próprio agente).
  const central = generateKeyPair();
  const agent = generateKeyPair();

  it('admin envia mensagem cifrada (POST); servidor não vê texto em claro', async () => {
    const ciphertext = sealMessage('Comando: manter posição.', central.secretKey, [
      { id: 'AG-0456', publicKey: agent.publicKey },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.type).toBe('text');
    expect(msg.text).toBeUndefined();
    expect(msg.ciphertext).toBe(ciphertext);
    expect(msg.senderId).toBeTruthy();
  });

  it('agente envia mensagem com senderId = agentId', async () => {
    const ciphertext = sealMessage('Alvo avistado.', agent.secretKey, [
      { id: 'AG-0456', publicKey: agent.publicKey },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ciphertext },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().senderId).toBe('AG-0456');
  });

  it('histórico traz os envelopes; só o destinatário decifra (sem texto em claro)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const texts = (res.json() as Array<{ type: string; ciphertext?: string }>)
      .filter((m) => m.type === 'text' && m.ciphertext)
      .map((m) => openMessage(m.ciphertext!, 'AG-0456', agent.secretKey));
    expect(texts).toContain('Alvo avistado.');
    expect(texts).toContain('Comando: manter posição.');
    // Nenhum texto em claro trafega na resposta.
    expect(JSON.stringify(res.json())).not.toContain('Alvo avistado.');
  });

  it('rejeita mensagem sem ciphertext com 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: '' },
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

describe('broadcast E2EE da central (admin → agentes)', () => {
  const central = generateKeyPair();
  const agent = generateKeyPair();

  it('emite broadcast cifrado; servidor NÃO armazena texto em claro; agente decifra', async () => {
    // A central cifra localmente para o agente AG-0456 (envelope por destinatário).
    const ciphertext = sealMessage('CENTRAL: recolher ao ponto de encontro.', central.secretKey, [
      { id: 'AG-0456', publicKey: agent.publicKey },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('broadcast');

    const hist = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    const broadcast = (
      hist.json() as Array<{ type: string; text?: string; ciphertext?: string }>
    ).find((m) => m.type === 'broadcast');

    // O servidor persiste só o envelope — nunca o texto em claro.
    expect(broadcast?.text).toBeUndefined();
    expect(broadcast?.ciphertext).toBe(ciphertext);
    // O texto em claro não pode aparecer em lugar nenhum da resposta.
    expect(JSON.stringify(hist.json())).not.toContain('recolher ao ponto de encontro');

    // Só o agente destinatário, com sua chave secreta, recupera a diretiva.
    expect(openMessage(broadcast!.ciphertext!, 'AG-0456', agent.secretKey)).toBe(
      'CENTRAL: recolher ao ponto de encontro.',
    );
  });

  it('agente (não-admin) não pode emitir broadcast (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ciphertext: 'tentativa-indevida' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('bloqueia broadcast em operação fora do escopo (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operations/000000000000000000000000/broadcast',
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: 'fora-do-escopo' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejeita broadcast sem ciphertext (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Núcleo Zero Trust: um portador escopado à operação A não pode ler nem escrever
 * dados de uma operação B REAL (com dados reais), e vice-versa. Prova as duas
 * garantias da regra mqtt-multitenant: (1) `assertOperationScope` bloqueia acesso
 * fora do escopo (403 simétrico); (2) toda query filtra por `operationId`, então
 * uma consulta escopada nunca vaza dados de outra operação.
 */
describe('isolamento multitenant (Zero Trust)', () => {
  let opBId: string;
  let tokenAlpha: string; // admin escopado SÓ à operação A (operationId)
  let tokenBravo: string; // admin escopado SÓ à operação B (opBId)
  const bravoKeys = generateKeyPair();
  const bravoCiphertext = sealMessage('Bravo: perímetro seguro.', bravoKeys.secretKey, [
    { id: 'BRAVO', publicKey: bravoKeys.publicKey },
  ]);

  beforeAll(async () => {
    const { User, Operation, Position } = await import('../models/index.js');

    const opB = await Operation.create({ name: 'Op Bravo', type: 'mandado', status: 'ativa' });
    opBId = String(opB._id);

    await User.create({
      username: 'admin_alpha',
      name: 'Central Alpha',
      passwordHash: await bcrypt.hash('cerberus123', 10),
      role: 'admin',
      operationIds: [operationId], // escopo = A
    });
    await User.create({
      username: 'admin_bravo',
      name: 'Central Bravo',
      passwordHash: await bcrypt.hash('cerberus123', 10),
      role: 'admin',
      operationIds: [opB._id], // escopo = B
    });

    // Posição real sob a operação B (agente distinto do AG-0456 da operação A).
    await Position.create({
      operationId: opBId,
      agentId: 'AG-BRAVO',
      location: { type: 'Point', coordinates: [-46.6333, -23.5505] }, // São Paulo
      accuracy: 10,
      capturedAt: new Date(),
      receivedAt: new Date(),
    });

    const la = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin_alpha', password: 'cerberus123' },
    });
    tokenAlpha = la.json().token;
    const lb = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin_bravo', password: 'cerberus123' },
    });
    tokenBravo = lb.json().token;

    // Mensagem real (cifrada) sob a operação B — exercita também o write path E2EE.
    await app.inject({
      method: 'POST',
      url: `/operations/${opBId}/messages`,
      headers: { authorization: `Bearer ${tokenBravo}` },
      payload: { ciphertext: bravoCiphertext },
    });
  }, 60_000);

  it('escopo A não acessa a operação B (GET /operations/:id → 403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${opBId}`,
      headers: { authorization: `Bearer ${tokenAlpha}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('escopo A não lê posições da operação B (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${opBId}/positions/latest`,
      headers: { authorization: `Bearer ${tokenAlpha}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('escopo A não lê nem envia mensagens da operação B (403)', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/operations/${opBId}/messages`,
      headers: { authorization: `Bearer ${tokenAlpha}` },
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: 'POST',
      url: `/operations/${opBId}/messages`,
      headers: { authorization: `Bearer ${tokenAlpha}` },
      payload: { ciphertext: 'injecao-indevida-entre-operacoes' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('escopo B não acessa a operação A (403) — isolamento simétrico', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/positions/latest`,
      headers: { authorization: `Bearer ${tokenBravo}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('consulta escopada retorna SÓ os dados da própria operação (sem vazamento)', async () => {
    const pos = await app.inject({
      method: 'GET',
      url: `/operations/${opBId}/positions`,
      headers: { authorization: `Bearer ${tokenBravo}` },
    });
    expect(pos.statusCode).toBe(200);
    const agents = (pos.json() as Array<{ agentId: string }>).map((p) => p.agentId);
    expect(agents).toContain('AG-BRAVO'); // dados da própria operação
    expect(agents).not.toContain('AG-0456'); // NÃO vaza a operação A

    const msgs = await app.inject({
      method: 'GET',
      url: `/operations/${opBId}/messages`,
      headers: { authorization: `Bearer ${tokenBravo}` },
    });
    expect(msgs.statusCode).toBe(200);
    const list = msgs.json() as Array<{ senderId: string; type: string; ciphertext?: string }>;
    const decrypted = list
      .filter((m) => m.type === 'text' && m.ciphertext)
      .map((m) => openMessage(m.ciphertext!, 'BRAVO', bravoKeys.secretKey));
    expect(decrypted).toContain('Bravo: perímetro seguro.'); // dados da própria operação
    // NÃO vaza a operação A: nenhuma mensagem do agente AG-0456 aparece aqui.
    expect(list.map((m) => m.senderId)).not.toContain('AG-0456');
  });
});

describe('mídia E2EE (GridFS)', () => {
  let mediaRef: string;
  const agentKeys = generateKeyPair();
  // O cliente cifra a imagem e embrulha legenda+geotag+chave da imagem num envelope.
  const img = encryptBytes(new Uint8Array(PNG));
  const metadata = JSON.stringify({
    caption: 'Veículo suspeito na esquina.',
    lat: -19.9319,
    lng: -43.9386,
    mime: 'image/png',
    k: img.key,
    n: img.nonce,
  });
  const mediaEnvelope = sealMessage(metadata, agentKeys.secretKey, [
    { id: 'AG-0456', publicKey: agentKeys.publicKey },
  ]);

  it('agente faz upload de mídia cifrada (POST /media) → 201, blob opaco', async () => {
    const form = new FormData();
    // O envelope vem ANTES do arquivo (para o multipart populá-lo em file.fields).
    form.append('ciphertext', mediaEnvelope);
    form.append('file', Buffer.from(img.cipher), {
      filename: 'media.bin',
      contentType: 'application/octet-stream',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('media');
    expect(body.mediaRef).toBeTruthy();
    expect(body.ciphertext).toBe(mediaEnvelope);
    expect(body.text).toBeUndefined(); // nenhuma legenda em claro
    mediaRef = body.mediaRef;
  });

  it('histórico traz o envelope; a legenda/geotag só saem ao decifrar', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const media = (res.json() as Array<{ type: string; ciphertext?: string }>).find(
      (m) => m.type === 'media',
    );
    const meta = JSON.parse(openMessage(media!.ciphertext!, 'AG-0456', agentKeys.secretKey)!);
    expect(meta.caption).toBe('Veículo suspeito na esquina.');
    expect(meta.lat).toBeCloseTo(-19.9319);
    // Nenhuma legenda em claro trafega na resposta.
    expect(JSON.stringify(res.json())).not.toContain('Veículo suspeito');
  });

  it('stream devolve o blob CIFRADO; só a chave do envelope recupera a imagem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/media/${mediaRef}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    // O que o servidor guarda é o cipher (≠ PNG); decifrado, volta a imagem original.
    const stored = new Uint8Array(res.rawPayload);
    expect(Buffer.from(stored).equals(PNG)).toBe(false);
    const back = decryptBytes(stored, img.key, img.nonce);
    expect(back && Buffer.from(back).equals(PNG)).toBe(true);
  });

  it('rejeita upload sem envelope E2EE (400)', async () => {
    const form = new FormData();
    form.append('file', Buffer.from('qualquer'), {
      filename: 'a.bin',
      contentType: 'application/octet-stream',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('bloqueia upload em operação fora do escopo (403)', async () => {
    const form = new FormData();
    form.append('ciphertext', mediaEnvelope);
    form.append('file', Buffer.from(img.cipher), {
      filename: 'media.bin',
      contentType: 'application/octet-stream',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/operations/000000000000000000000000/media',
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('mídia inexistente na operação → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/media/000000000000000000000000`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('geofencing + alertas', () => {
  let geofenceId: string;

  it('admin cria geofence (POST) → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Perímetro Alfa',
        lng: -43.9386,
        lat: -19.9319,
        radiusMeters: 150,
        color: 'blue',
      },
    });
    expect(res.statusCode).toBe(201);
    const g = res.json();
    expect(g.name).toBe('Perímetro Alfa');
    expect(g.radiusMeters).toBe(150);
    expect(g.color).toBe('blue');
    geofenceId = g.id;
  });

  it('agente (não-admin) não cria geofence (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { name: 'x', lng: 0, lat: 0, radiusMeters: 10 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lista geofences inclui a criada', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ name: string }>).some((g) => g.name === 'Perímetro Alfa')).toBe(
      true,
    );
  });

  it('bloqueia geofences fora do escopo (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operations/000000000000000000000000/geofences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET alerts retorna alertas persistidos', async () => {
    const { Alert } = await import('../models/index.js');
    await Alert.create({
      operationId,
      agentId: 'AG-0456',
      geofenceId,
      geofenceName: 'Perímetro Alfa',
      type: 'enter',
      location: { type: 'Point', coordinates: [-43.9386, -19.9319] },
      capturedAt: new Date(),
      receivedAt: new Date(),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const alerts = res.json() as Array<{ type: string; geofenceName: string }>;
    expect(alerts.some((a) => a.type === 'enter' && a.geofenceName === 'Perímetro Alfa')).toBe(
      true,
    );
  });

  it('admin edita geofence (PATCH: mover + redimensionar)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}/geofences/${geofenceId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { lng: -43.94, lat: -19.95, radiusMeters: 300 },
    });
    expect(res.statusCode).toBe(200);
    const g = res.json();
    expect(g.radiusMeters).toBe(300);
    expect(g.lat).toBeCloseTo(-19.95);
    expect(g.lng).toBeCloseTo(-43.94);
  });

  it('agente (não-admin) não edita geofence (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}/geofences/${geofenceId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { radiusMeters: 500 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('recalcula alertas do histórico (replay) → enter + exit', async () => {
    const { Geofence, Position } = await import('../models/index.js');
    await Geofence.create({
      operationId,
      name: 'ZonaReplay',
      center: { type: 'Point', coordinates: [-43.9, -19.9] },
      radiusMeters: 150,
      color: 'blue',
    });
    // Dentro → depois longe (fora): deve gerar enter e exit para AG-REPLAY.
    await Position.create({
      operationId,
      agentId: 'AG-REPLAY',
      location: { type: 'Point', coordinates: [-43.9, -19.9] },
      capturedAt: new Date('2026-07-11T10:00:00Z'),
      receivedAt: new Date(),
    });
    await Position.create({
      operationId,
      agentId: 'AG-REPLAY',
      location: { type: 'Point', coordinates: [-43.8, -19.8] },
      capturedAt: new Date('2026-07-11T10:01:00Z'),
      receivedAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alertsCreated).toBeGreaterThanOrEqual(2);

    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const mine = (alerts.json() as Array<{ type: string; agentId: string }>)
      .filter((a) => a.agentId === 'AG-REPLAY')
      .map((a) => a.type);
    expect(mine).toEqual(expect.arrayContaining(['enter', 'exit']));
  });

  it('zona criada em volta de agente JÁ dentro semeia pertencimento (sem enter falso)', async () => {
    const { Position, GeofenceMembership } = await import('../models/index.js');
    const center = { lng: -43.3, lat: -19.3 };
    // Última posição conhecida do agente: parado DENTRO da futura zona.
    await Position.create({
      operationId,
      agentId: 'AG-INSIDE',
      location: { type: 'Point', coordinates: [center.lng, center.lat] },
      capturedAt: new Date('2026-07-13T09:00:00Z'),
      receivedAt: new Date(),
    });
    const create = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'ZonaEnvolvente', lng: center.lng, lat: center.lat, radiusMeters: 150, color: 'teal' },
    });
    expect(create.statusCode).toBe(201);
    const gid = create.json().id as string;
    // Pertencimento semeado como "dentro" → a próxima posição ao vivo não vira enter.
    const mem = await GeofenceMembership.findOne({
      operationId,
      agentId: 'AG-INSIDE',
      geofenceId: gid,
    }).lean();
    expect(mem?.inside).toBe(true);
    // A criação não gera alertas por si; nenhum enter falso para o agente já dentro.
    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const enters = (
      alerts.json() as Array<{ agentId: string; geofenceName: string; type: string }>
    ).filter(
      (a) => a.agentId === 'AG-INSIDE' && a.geofenceName === 'ZonaEnvolvente' && a.type === 'enter',
    );
    expect(enters).toHaveLength(0);
  });

  it('agente (não-admin) não recalcula alertas (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin remove geofence (DELETE) → 204 e some da lista', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/operations/${operationId}/geofences/${geofenceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list.json() as Array<{ id: string }>).some((g) => g.id === geofenceId)).toBe(false);
  });

  it('cria retângulo via API (201) e detecta enter/exit (replay)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'RetânguloAlfa',
        shape: 'rectangle',
        lng: -44.5,
        lat: -20.5,
        widthMeters: 200,
        heightMeters: 200,
        rotationDeg: 30,
        color: 'amber',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ shape: 'rectangle', widthMeters: 200, rotationDeg: 30 });

    const { Position } = await import('../models/index.js');
    await Position.create({
      operationId,
      agentId: 'AG-RECT',
      location: { type: 'Point', coordinates: [-44.5, -20.5] }, // centro → dentro
      capturedAt: new Date('2026-07-11T11:00:00Z'),
      receivedAt: new Date(),
    });
    await Position.create({
      operationId,
      agentId: 'AG-RECT',
      location: { type: 'Point', coordinates: [-44.0, -20.0] }, // longe → fora
      capturedAt: new Date('2026-07-11T11:01:00Z'),
      receivedAt: new Date(),
    });

    const rec = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rec.statusCode).toBe(200);

    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const mine = (alerts.json() as Array<{ type: string; agentId: string }>)
      .filter((a) => a.agentId === 'AG-RECT')
      .map((a) => a.type);
    expect(mine).toEqual(expect.arrayContaining(['enter', 'exit']));
  });

  it('cria polígono via API (201) e detecta enter/exit (replay, ray-casting)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'PolígonoAlfa',
        shape: 'polygon',
        // Quadrado ~2 km em torno de (-45.5, -21.5).
        vertices: [
          [-45.51, -21.51],
          [-45.49, -21.51],
          [-45.49, -21.49],
          [-45.51, -21.49],
        ],
        color: 'purple',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ shape: 'polygon' });
    expect(create.json().vertices).toHaveLength(4);

    const { Position } = await import('../models/index.js');
    await Position.create({
      operationId,
      agentId: 'AG-POLY',
      location: { type: 'Point', coordinates: [-45.5, -21.5] }, // dentro
      capturedAt: new Date('2026-07-11T12:00:00Z'),
      receivedAt: new Date(),
    });
    await Position.create({
      operationId,
      agentId: 'AG-POLY',
      location: { type: 'Point', coordinates: [-45.0, -21.0] }, // fora
      capturedAt: new Date('2026-07-11T12:01:00Z'),
      receivedAt: new Date(),
    });

    const rec = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rec.statusCode).toBe(200);

    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const mine = (alerts.json() as Array<{ type: string; agentId: string }>)
      .filter((a) => a.agentId === 'AG-POLY')
      .map((a) => a.type);
    expect(mine).toEqual(expect.arrayContaining(['enter', 'exit']));
  });

  it('círculo sem shape ainda cria (retrocompat) e serializa shape=circle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'CírculoLegado', lng: -43.9, lat: -19.9, radiusMeters: 100 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().shape).toBe('circle');
  });

  // --- Fase 5b — zonas avançadas ---
  it('zona por equipe: só agentes da equipe geram alerta', async () => {
    const { Team, Position } = await import('../models/index.js');
    const team = await Team.create({ operationId, name: 'Equipe Zona', agentIds: ['AG-INTEAM'] });
    const create = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'ZonaEquipe',
        lng: -43.7,
        lat: -19.7,
        radiusMeters: 150,
        teamId: String(team._id),
        color: 'red',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().teamId).toBe(String(team._id));
    for (const agentId of ['AG-INTEAM', 'AG-OUTTEAM']) {
      await Position.create({
        operationId,
        agentId,
        location: { type: 'Point', coordinates: [-43.7, -19.7] },
        capturedAt: new Date('2026-07-12T12:00:00Z'),
        receivedAt: new Date(),
      });
    }
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const byAgent = (alerts.json() as Array<{ geofenceName: string; agentId: string }>)
      .filter((a) => a.geofenceName === 'ZonaEquipe')
      .map((a) => a.agentId);
    expect(byAgent).toContain('AG-INTEAM');
    expect(byAgent).not.toContain('AG-OUTTEAM');
  });

  it('agendamento: posição fora da janela horária não alerta', async () => {
    const { Position } = await import('../models/index.js');
    // Janela 10:00–11:00 UTC (600–660 min).
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'ZonaAgenda',
        lng: -43.6,
        lat: -19.6,
        radiusMeters: 150,
        windowStartMin: 600,
        windowEndMin: 660,
        color: 'orange',
      },
    });
    await Position.create({
      operationId,
      agentId: 'AG-SCHED-OUT',
      location: { type: 'Point', coordinates: [-43.6, -19.6] },
      capturedAt: new Date('2026-07-12T08:00:00Z'), // fora da janela
      receivedAt: new Date(),
    });
    await Position.create({
      operationId,
      agentId: 'AG-SCHED-IN',
      location: { type: 'Point', coordinates: [-43.6, -19.6] },
      capturedAt: new Date('2026-07-12T10:30:00Z'), // dentro da janela
      receivedAt: new Date(),
    });
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const byAgent = (alerts.json() as Array<{ geofenceName: string; agentId: string }>)
      .filter((a) => a.geofenceName === 'ZonaAgenda')
      .map((a) => a.agentId);
    expect(byAgent).toContain('AG-SCHED-IN');
    expect(byAgent).not.toContain('AG-SCHED-OUT');
  });

  it('regra de gatilho "enter": a saída não gera alerta', async () => {
    const { Position } = await import('../models/index.js');
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'ZonaEnter',
        lng: -43.5,
        lat: -19.5,
        radiusMeters: 150,
        triggerOn: 'enter',
        color: 'green',
      },
    });
    await Position.create({
      operationId,
      agentId: 'AG-TRIG',
      location: { type: 'Point', coordinates: [-43.5, -19.5] }, // dentro
      capturedAt: new Date('2026-07-12T13:00:00Z'),
      receivedAt: new Date(),
    });
    await Position.create({
      operationId,
      agentId: 'AG-TRIG',
      location: { type: 'Point', coordinates: [-40, -18] }, // longe → sairia
      capturedAt: new Date('2026-07-12T13:01:00Z'),
      receivedAt: new Date(),
    });
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const types = (alerts.json() as Array<{ geofenceName: string; agentId: string; type: string }>)
      .filter((a) => a.geofenceName === 'ZonaEnter' && a.agentId === 'AG-TRIG')
      .map((a) => a.type);
    expect(types).toContain('enter');
    expect(types).not.toContain('exit');
  });

  it('severidade: o alerta herda a severidade da zona', async () => {
    const { Position } = await import('../models/index.js');
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'ZonaCritica',
        lng: -43.4,
        lat: -19.4,
        radiusMeters: 150,
        severity: 'critical',
        color: 'red',
      },
    });
    await Position.create({
      operationId,
      agentId: 'AG-SEV',
      location: { type: 'Point', coordinates: [-43.4, -19.4] },
      capturedAt: new Date('2026-07-12T14:00:00Z'),
      receivedAt: new Date(),
    });
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const crit = (alerts.json() as Array<{ geofenceName: string; severity: string }>).find(
      (a) => a.geofenceName === 'ZonaCritica',
    );
    expect(crit?.severity).toBe('critical');
  });
});

describe('configurações do sistema', () => {
  it('GET /settings retorna os padrões (min 5, ligar rotas off, gap 5 min)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      minRoutePoints: 5,
      connectRoutes: false,
      maxGapMinutes: 5,
      sidebarMessageCount: 5,
    });
  });

  it('admin altera a quantidade de mensagens do card (PATCH) e persiste', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { sidebarMessageCount: 12 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sidebarMessageCount: 12 });
  });

  it('GET /settings sem token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('admin altera as configurações (PATCH) e persiste', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { minRoutePoints: 8, connectRoutes: true, maxGapMinutes: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ minRoutePoints: 8, connectRoutes: true, maxGapMinutes: 10 });

    const again = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.json()).toMatchObject({
      minRoutePoints: 8,
      connectRoutes: true,
      maxGapMinutes: 10,
    });
  });

  it('agente (não-admin) não altera configurações (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { minRoutePoints: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejeita minRoutePoints inválido (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { minRoutePoints: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('RBAC superadmin (bypass de guardas)', () => {
  it('SA passa em rota admin+escopo de que não é membro (PATCH operação)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}`,
      headers: { authorization: `Bearer ${saToken}` },
      payload: { status: 'ativa' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('SA lê dados fora do seu escopo (bypass de assertOperationScope)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/positions/latest`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('SA lista TODAS as operações apesar de escopo vazio', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/operations',
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(operationId);
  });

  it('SA vê todos os papéis em /users; admin vê só agentes', async () => {
    const sa = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${saToken}` },
    });
    const saRoles = new Set((sa.json() as Array<{ role: string }>).map((u) => u.role));
    expect(saRoles.has('superadmin')).toBe(true);
    expect(saRoles.has('admin')).toBe(true);

    const adm = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
    });
    const admRoles = new Set((adm.json() as Array<{ role: string }>).map((u) => u.role));
    expect(admRoles.has('admin')).toBe(false);
    expect(admRoles.has('superadmin')).toBe(false);
    expect(admRoles.has('agente')).toBe(true);
  });
});

describe('hierarquia de usuários (RBAC)', () => {
  let adminTargetId: string;
  let agHierId: string;
  let agPromoteId: string;
  let selfAdminToken: string;
  let selfAdminId: string;
  let saId: string;

  beforeAll(async () => {
    const { User } = await import('../models/index.js');
    const mk = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${saToken}` },
        payload,
      });
    adminTargetId = (
      await mk({ username: 'admin_target', name: 'Admin Alvo', password: 'cerberus123', role: 'admin' })
    ).json().id;
    agHierId = (
      await mk({
        username: 'ag_hier',
        name: 'Agente H',
        password: 'cerberus123',
        role: 'agente',
        agentId: 'AG-H1',
      })
    ).json().id;
    agPromoteId = (
      await mk({
        username: 'ag_promote',
        name: 'Agente P',
        password: 'cerberus123',
        role: 'agente',
        agentId: 'AG-H2',
      })
    ).json().id;
    selfAdminId = (
      await mk({ username: 'admin_self', name: 'Admin Self', password: 'cerberus123', role: 'admin' })
    ).json().id;
    selfAdminToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'admin_self', password: 'cerberus123' },
      })
    ).json().token;
    const saUser = await User.findOne({ username: 'superadmin' }).lean();
    if (!saUser) throw new Error('superadmin não semeado');
    saId = String(saUser._id);
  });

  it('admin não cria admin nem superadmin (403)', async () => {
    for (const role of ['admin', 'superadmin']) {
      const res = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { authorization: `Bearer ${token}` },
        payload: { username: `x_${role}`, name: 'X', password: 'cerberus123', role },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('SA cria admin e superadmin (201); remove o SA extra p/ manter o invariante', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${saToken}` },
      payload: { username: 'sa_made_admin', name: 'A', password: 'cerberus123', role: 'admin' },
    });
    expect(a.statusCode).toBe(201);
    const s = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${saToken}` },
      payload: { username: 'sa_made_sa', name: 'S', password: 'cerberus123', role: 'superadmin' },
    });
    expect(s.statusCode).toBe(201);
    const del = await app.inject({
      method: 'DELETE',
      url: `/users/${s.json().id}`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('admin não enxerga admin (404 em GET/PATCH/DELETE)', async () => {
    const g = await app.inject({
      method: 'GET',
      url: `/users/${adminTargetId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(g.statusCode).toBe(404);
    const p = await app.inject({
      method: 'PATCH',
      url: `/users/${adminTargetId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'z' },
    });
    expect(p.statusCode).toBe(404);
    const d = await app.inject({
      method: 'DELETE',
      url: `/users/${adminTargetId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(d.statusCode).toBe(404);
  });

  it('admin edita agente (name 200) mas não o eleva (role→admin 403)', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/users/${agHierId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Novo Nome' },
    });
    expect(ok.statusCode).toBe(200);
    const esc = await app.inject({
      method: 'PATCH',
      url: `/users/${agHierId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'admin' },
    });
    expect(esc.statusCode).toBe(403);
  });

  it('SA promove agente a admin (200)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${agPromoteId}`,
      headers: { authorization: `Bearer ${saToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
  });

  it('autoexclusão bloqueada (403) para admin e SA', async () => {
    const a = await app.inject({
      method: 'DELETE',
      url: `/users/${selfAdminId}`,
      headers: { authorization: `Bearer ${selfAdminToken}` },
    });
    expect(a.statusCode).toBe(403);
    const s = await app.inject({
      method: 'DELETE',
      url: `/users/${saId}`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(s.statusCode).toBe(403);
  });

  it('rebaixar o último superadmin é bloqueado (409)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${saId}`,
      headers: { authorization: `Bearer ${saToken}` },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('self-exception: admin troca a própria senha e loga com ela (200)', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/users/${selfAdminId}`,
      headers: { authorization: `Bearer ${selfAdminToken}` },
      payload: { password: 'novaSenha1' },
    });
    expect(patch.statusCode).toBe(200);
    const relogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin_self', password: 'novaSenha1' },
    });
    expect(relogin.statusCode).toBe(200);
  });
});

describe('exclusão de operação (superadmin)', () => {
  let delOpId: string;
  let memberId: string;

  beforeAll(async () => {
    const { Operation, Position, MessageModel, Geofence, Alert, GeofenceMembership, User } =
      await import('../models/index.js');
    const op = await Operation.create({ name: 'Op Excluir', type: 'escolta', status: 'ativa' });
    delOpId = String(op._id);
    await Position.create({
      operationId: delOpId,
      agentId: 'AG-DEL',
      location: { type: 'Point', coordinates: [-43.9, -19.9] },
      capturedAt: new Date(),
      receivedAt: new Date(),
    });
    await MessageModel.create({
      operationId: delOpId,
      senderId: 'AG-DEL',
      type: 'text',
      ciphertext: 'x',
      capturedAt: new Date(),
      receivedAt: new Date(),
    });
    const gf = await Geofence.create({
      operationId: delOpId,
      name: 'Z',
      center: { type: 'Point', coordinates: [-43.9, -19.9] },
      radiusMeters: 100,
    });
    await Alert.create({
      operationId: delOpId,
      agentId: 'AG-DEL',
      geofenceId: String(gf._id),
      geofenceName: 'Z',
      type: 'enter',
      location: { type: 'Point', coordinates: [-43.9, -19.9] },
      capturedAt: new Date(),
      receivedAt: new Date(),
    });
    await GeofenceMembership.create({
      operationId: delOpId,
      agentId: 'AG-DEL',
      geofenceId: String(gf._id),
      inside: true,
      updatedAt: new Date(),
    });
    const member = await User.create({
      username: 'membro_del',
      name: 'Membro',
      passwordHash: await bcrypt.hash('cerberus123', 10),
      role: 'agente',
      agentId: 'AG-DEL',
      operationIds: [op._id],
    });
    memberId = String(member._id);
  });

  it('admin não exclui operação (403 — SA-only)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/operations/${delOpId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('SA exclui a operação em cascata (204)', async () => {
    const { Operation, Position, MessageModel, Geofence, Alert, GeofenceMembership, User } =
      await import('../models/index.js');
    const res = await app.inject({
      method: 'DELETE',
      url: `/operations/${delOpId}`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await Operation.findById(delOpId)).toBeNull();
    expect(await Position.countDocuments({ operationId: delOpId })).toBe(0);
    expect(await MessageModel.countDocuments({ operationId: delOpId })).toBe(0);
    expect(await Geofence.countDocuments({ operationId: delOpId })).toBe(0);
    expect(await Alert.countDocuments({ operationId: delOpId })).toBe(0);
    expect(await GeofenceMembership.countDocuments({ operationId: delOpId })).toBe(0);
    const member = await User.findById(memberId).lean();
    expect((member?.operationIds ?? []).map(String)).not.toContain(delOpId);
  });

  it('excluir operação inexistente (404)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/operations/000000000000000000000000',
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('sessões e dispositivos (1b)', () => {
  const loginDevice = async (username: string, password: string, deviceId?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username, password, ...(deviceId ? { deviceId, platform: 'android' } : {}) },
    });
    const token = res.json().token as string | undefined;
    const sid = token ? (app.jwt.decode(token) as { sid?: string } | null)?.sid : undefined;
    return { statusCode: res.statusCode, token: token ?? '', sid };
  };
  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
  const findUserId = async (username: string): Promise<string> => {
    const { User } = await import('../models/index.js');
    const u = await User.findOne({ username }).lean();
    if (!u) throw new Error(`usuário ${username} não encontrado`);
    return String(u._id);
  };
  const mkAgent = async (username: string, agentId: string) => {
    const { User } = await import('../models/index.js');
    await User.create({
      username,
      name: username,
      passwordHash: await bcrypt.hash('cerberus123', 10),
      role: 'agente',
      agentId,
      operationIds: [],
    });
  };

  it('login cria sessão com sid; /auth/session 200; token legado sem sid 200 (fail-open)', async () => {
    const { token, sid } = await loginDevice('agente01', 'cerberus123', 'DEV-A');
    expect(sid).toBeTruthy();
    const sess = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sess.statusCode).toBe(200);
    const legacy = app.jwt.sign({ sub: '000000000000000000000001', role: 'agente', operationIds: [] });
    expect((await me(legacy)).statusCode).toBe(200); // sem sid → fail-open
  });

  it('kick revoga a sessão (401); o usuário reloga e o novo token funciona (kick ≠ block)', async () => {
    await mkAgent('sess_kick', 'AG-K');
    const { token, sid } = await loginDevice('sess_kick', 'cerberus123', 'DEV-K');
    expect((await me(token)).statusCode).toBe(200);
    const kick = await app.inject({
      method: 'POST',
      url: `/sessions/${sid}/kick`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(kick.statusCode).toBe(204);
    expect((await me(token)).statusCode).toBe(401);
    const relog = await loginDevice('sess_kick', 'cerberus123', 'DEV-K');
    expect((await me(relog.token)).statusCode).toBe(200);
  });

  it('rotas de gestão exigem SUPERADMIN (admin/agente 403)', async () => {
    for (const t of [token, agentToken]) {
      const r = await app.inject({
        method: 'GET',
        url: '/audit',
        headers: { authorization: `Bearer ${t}` },
      });
      expect(r.statusCode).toBe(403);
    }
  });

  it('block de conta: token 401, login recusado; unblock reloga (token antigo segue morto)', async () => {
    await mkAgent('sess_block', 'AG-B');
    const uid = await findUserId('sess_block');
    const { token: t1 } = await loginDevice('sess_block', 'cerberus123', 'DEV-B1');
    const block = await app.inject({
      method: 'POST',
      url: `/users/${uid}/block`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(block.statusCode).toBe(204);
    expect((await me(t1)).statusCode).toBe(401);
    const loginBlocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'sess_block', password: 'cerberus123' },
    });
    expect(loginBlocked.statusCode).toBe(403);
    const unblock = await app.inject({
      method: 'POST',
      url: `/users/${uid}/unblock`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(unblock.statusCode).toBe(204);
    const relog = await loginDevice('sess_block', 'cerberus123', 'DEV-B1');
    expect((await me(relog.token)).statusCode).toBe(200);
    expect((await me(t1)).statusCode).toBe(401); // token antigo segue revogado
  });

  it('block de dispositivo: sessões do device morrem, outro device sobrevive, login recusado', async () => {
    await mkAgent('dev_user', 'AG-D');
    const a = await loginDevice('dev_user', 'cerberus123', 'DEV-X');
    const b = await loginDevice('dev_user', 'cerberus123', 'DEV-X');
    const other = await loginDevice('dev_user', 'cerberus123', 'DEV-Y');
    const blk = await app.inject({
      method: 'POST',
      url: '/devices/DEV-X/block',
      headers: { authorization: `Bearer ${saToken}` },
      payload: { reason: 'perdido' },
    });
    expect(blk.statusCode).toBe(204);
    expect((await me(a.token)).statusCode).toBe(401);
    expect((await me(b.token)).statusCode).toBe(401);
    expect((await me(other.token)).statusCode).toBe(200);
    const loginBlockedDev = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'dev_user', password: 'cerberus123', deviceId: 'DEV-X' },
    });
    expect(loginBlockedDev.statusCode).toBe(403);
    const blocked = await app.inject({
      method: 'GET',
      url: '/devices/blocked',
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect((blocked.json() as Array<{ deviceId: string }>).map((d) => d.deviceId)).toContain('DEV-X');
  });

  it('self-block do SA é bloqueado (403)', async () => {
    const saId = await findUserId('superadmin');
    const res = await app.inject({
      method: 'POST',
      url: `/users/${saId}/block`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refresh reusa o sid; token legado ganha um sid', async () => {
    const { token, sid } = await loginDevice('agente01', 'cerberus123', 'DEV-R');
    const refr = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refr.statusCode).toBe(200);
    expect((app.jwt.decode(refr.json().token) as { sid?: string } | null)?.sid).toBe(sid);

    const agenteId = await findUserId('agente01');
    const legacy = app.jwt.sign({ sub: agenteId, role: 'agente', operationIds: [] });
    const refrLegacy = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(refrLegacy.statusCode).toBe(200);
    expect((app.jwt.decode(refrLegacy.json().token) as { sid?: string } | null)?.sid).toBeTruthy();
  });

  it('auditoria (SA) lista kick/block; lista de dispositivos de um usuário', async () => {
    const audit = await app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(audit.statusCode).toBe(200);
    const actions = (audit.json() as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('session.kick');
    expect(actions).toContain('user.block');
    expect(actions).toContain('device.block');

    const devs = await app.inject({
      method: 'GET',
      url: `/users/${await findUserId('agente01')}/devices`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(devs.statusCode).toBe(200);
    expect(Array.isArray(devs.json())).toBe(true);
  });
});

describe('equipes (Fase 2a)', () => {
  let teamId: string;
  const FOREIGN_OP = 'ffffffffffffffffffffffff'; // operação fora do escopo do admin

  it('admin cria equipe na sua operação (201) com membro e líder válidos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Alfa', color: 'blue', agentIds: ['AG-0456'], leadId: 'AG-0456' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Alfa',
      color: 'blue',
      agentIds: ['AG-0456'],
      leadId: 'AG-0456',
      operationId,
    });
    teamId = res.json().id;
  });

  it('lista as equipes da operação (contém a criada)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ name: string }>).map((t) => t.name)).toContain('Alfa');
  });

  it('rejeita membro fora da operação (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Bravo', agentIds: ['AG-0457'] }, // AG-0457 não está na operação
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejeita líder que não é membro (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Charlie', agentIds: ['AG-0456'], leadId: 'AG-9999' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('nome duplicado na mesma operação (409)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Alfa' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('agente não cria equipe (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { name: 'Delta' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('sem token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      payload: { name: 'Echo' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('operação fora do escopo do admin (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${FOREIGN_OP}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Foxtrot' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('superadmin cria em qualquer operação (bypass de escopo)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${saToken}` },
      payload: { name: 'SA-Team', agentIds: ['AG-0456'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH troca cor e esvazia membros/líder (200)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/operations/${operationId}/teams/${teamId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { color: 'amber', agentIds: [], leadId: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ color: 'amber', agentIds: [] });
    expect(res.json().leadId).toBeUndefined();
  });

  it('GET /teams: admin vê as da sua operação; SA vê ao menos o mesmo', async () => {
    const adminList = await app.inject({
      method: 'GET',
      url: '/teams',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(adminList.statusCode).toBe(200);
    const adminOps = new Set(
      (adminList.json() as Array<{ operationId: string }>).map((t) => t.operationId),
    );
    expect(adminOps.has(operationId)).toBe(true);

    const saList = await app.inject({
      method: 'GET',
      url: '/teams',
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(saList.statusCode).toBe(200);
    expect((saList.json() as unknown[]).length).toBeGreaterThanOrEqual(
      (adminList.json() as unknown[]).length,
    );
  });

  it('DELETE remove a equipe (204) e some da lista', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/operations/${operationId}/teams/${teamId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((list.json() as Array<{ id: string }>).map((t) => t.id)).not.toContain(teamId);
  });
});

describe('mensageria de equipe/DM (Fase 2b)', () => {
  let teamWithAgent: string; // equipe com AG-0456
  let teamWithout: string; // equipe sem AG-0456 (para testar 403 de não-membro)
  const CT = 'ciphertext-fake-envelope'; // o servidor só armazena/republica opaco

  beforeAll(async () => {
    const t1 = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'MsgTeam', agentIds: ['AG-0456'] },
    });
    teamWithAgent = t1.json().id;
    const t2 = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'EmptyTeam', agentIds: [] },
    });
    teamWithout = t2.json().id;
  });

  it('membro (agente) envia mensagem à equipe (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/${teamWithAgent}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ teamId: teamWithAgent, type: 'text' });
    expect(res.json().ciphertext).toBe(CT);
  });

  it('admin envia à equipe (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/${teamWithAgent}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(201);
  });

  it('agente fora da equipe não envia (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/${teamWithout}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(403);
  });

  it('histórico da equipe retorna as mensagens (todas com o teamId)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/teams/${teamWithAgent}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const arr = res.json() as Array<{ teamId: string }>;
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr.every((m) => m.teamId === teamWithAgent)).toBe(true);
  });

  it('equipe inexistente (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/ffffffffffffffffffffffff/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(404);
  });

  it('mensagem de equipe fora do escopo (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/ffffffffffffffffffffffff/teams/${teamWithAgent}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin envia DM a um agente (201) e persiste recipientId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/agents/AG-0456/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientId: 'AG-0456', type: 'text' });
  });

  it('agente não envia DM (403 — requireRole ADMIN)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/agents/AG-0456/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DM sem token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/agents/AG-0456/messages`,
      payload: { ciphertext: CT },
    });
    expect(res.statusCode).toBe(401);
  });

  it('o próprio agente lê seu DM (200); só mensagens do canal DM do agente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/AG-0456/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const arr = res.json() as Array<{ recipientId?: string; senderId: string }>;
    expect(arr.length).toBeGreaterThanOrEqual(1);
    // Bidirecional: central→agente (recipientId) OU agente→central (senderId).
    expect(arr.every((m) => m.recipientId === 'AG-0456' || m.senderId === 'AG-0456')).toBe(true);
  });

  it('DM traz as mensagens DO agente (senderId, sem teamId), não só as recebidas', async () => {
    const { MessageModel } = await import('../models/index.js');
    await MessageModel.create({
      operationId,
      senderId: 'AG-0456',
      type: 'text',
      ciphertext: 'ct-do-agente-para-central',
      capturedAt: new Date(),
      receivedAt: new Date(),
    }); // sem teamId nem recipientId — mensagem direta do agente à central (via ponte MQTT)
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/AG-0456/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const arr = res.json() as Array<{ senderId: string; ciphertext?: string }>;
    expect(arr.some((m) => m.senderId === 'AG-0456' && m.ciphertext === 'ct-do-agente-para-central')).toBe(
      true,
    );
  });
});

describe('mídia de equipe/DM (Fase 3b-2)', () => {
  let teamId: string;
  let emptyTeamId: string;
  const CT = 'ciphertext-media-envelope';
  const fileBuf = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  function mediaForm(): FormData {
    const form = new FormData();
    // O envelope vem ANTES do arquivo (para o multipart populá-lo em file.fields).
    form.append('ciphertext', CT);
    form.append('file', fileBuf, { filename: 'm.bin', contentType: 'application/octet-stream' });
    return form;
  }

  beforeAll(async () => {
    const t1 = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'MediaTeam', agentIds: ['AG-0456'] },
    });
    teamId = t1.json().id;
    const t2 = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'MediaEmpty', agentIds: [] },
    });
    emptyTeamId = t2.json().id;
  });

  it('membro envia mídia à equipe (201) com teamId', async () => {
    const form = mediaForm();
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/${teamId}/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'media', teamId });
    expect(res.json().mediaRef).toBeTruthy();
  });

  it('agente fora da equipe não envia mídia (403)', async () => {
    const form = mediaForm();
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/${emptyTeamId}/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('mídia p/ equipe inexistente (404)', async () => {
    const form = mediaForm();
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/teams/ffffffffffffffffffffffff/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${token}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('admin envia mídia DM a um agente (201) com recipientId', async () => {
    const form = mediaForm();
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/agents/AG-0456/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${token}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'media', recipientId: 'AG-0456' });
  });

  it('agente não envia mídia DM (403 — requireRole ADMIN)', async () => {
    const form = mediaForm();
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/agents/AG-0456/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('histórico da equipe inclui a mídia (com teamId + mediaRef)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/teams/${teamId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const media = (res.json() as Array<{ type: string; mediaRef?: string; teamId?: string }>).find(
      (m) => m.type === 'media',
    );
    expect(media?.teamId).toBe(teamId);
    expect(media?.mediaRef).toBeTruthy();
  });
});

describe('estatísticas de mídia — favoritos + views (Fase 6b)', () => {
  const mediaId = 'media-6b-test';
  const view = (t: string) =>
    app.inject({
      method: 'POST',
      url: `/operations/${operationId}/media/${mediaId}/view`,
      headers: { authorization: `Bearer ${t}` },
    });
  const fav = (t: string) =>
    app.inject({
      method: 'POST',
      url: `/operations/${operationId}/media/${mediaId}/favorite`,
      headers: { authorization: `Bearer ${t}` },
    });

  it('view registra visualização única por usuário (idempotente)', async () => {
    expect((await view(token)).json().views).toBe(1);
    expect((await view(token)).json().views).toBe(1); // mesma pessoa → não soma
    expect((await view(agentToken)).json().views).toBe(2); // outro usuário → soma
  });

  it('favorite alterna o favorito do usuário', async () => {
    expect((await fav(token)).json()).toMatchObject({ favorited: true, favorites: 1 });
    expect((await fav(token)).json()).toMatchObject({ favorited: false, favorites: 0 });
  });

  it('media-stats devolve views + se EU favoritei', async () => {
    await fav(token); // liga de novo
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/media-stats`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const stat = (res.json() as Array<{ mediaId: string; views: number; favorited: boolean }>).find(
      (s) => s.mediaId === mediaId,
    );
    expect(stat).toMatchObject({ views: 2, favorited: true });
  });

  it('media-stats sem token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/operations/${operationId}/media-stats` });
    expect(res.statusCode).toBe(401);
  });
});

describe('rotação de chave E2EE (Fase 5e-2)', () => {
  const put = (pk: string) =>
    app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: pk },
    });

  it('nova chave vira a atual; a anterior vai ao histórico; re-registrar é idempotente', async () => {
    const k1 = generateKeyPair();
    const k2 = generateKeyPair();
    await put(k1.publicKey); // registra k1 (a chave corrente anterior vai ao histórico)
    await put(k2.publicKey); // rotaciona → k1 vai ao histórico
    await put(k2.publicKey); // re-registra a mesma → idempotente
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    const admin = (
      res.json() as Array<{ role: string; publicKey: string; keyHistory?: string[]; revoked?: boolean }>
    ).find((e) => e.role === 'admin');
    expect(admin?.publicKey).toBe(k2.publicKey);
    expect(admin?.keyHistory).toContain(k1.publicKey);
    expect(admin?.keyHistory?.filter((h) => h === k1.publicKey).length).toBe(1); // sem duplicar
    expect(admin?.revoked).toBe(false);
  });

  it('revogar chave (SA) marca revoked; agente comum 403; rotacionar limpa a flag', async () => {
    const adminId = (app.jwt.decode(token) as { sub: string }).sub;
    const revokedOf = async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/operations/${operationId}/keys`,
        headers: { authorization: `Bearer ${token}` },
      });
      return (res.json() as Array<{ role: string; revoked?: boolean }>).find(
        (e) => e.role === 'admin',
      )?.revoked;
    };
    // só SUPERADMIN revoga; agente comum → 403.
    const forbidden = await app.inject({
      method: 'POST',
      url: `/users/${adminId}/revoke-key`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    // SA revoga → o diretório passa a devolver revoked:true.
    const revoke = await app.inject({
      method: 'POST',
      url: `/users/${adminId}/revoke-key`,
      headers: { authorization: `Bearer ${saToken}` },
    });
    expect(revoke.statusCode).toBe(204);
    expect(await revokedOf()).toBe(true);
    // rotacionar (PUT nova pública) limpa a revogação.
    await app.inject({
      method: 'PUT',
      url: '/auth/public-key',
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: generateKeyPair().publicKey },
    });
    expect(await revokedOf()).toBe(false);
  });
});

describe('backup de chave E2EE na nuvem (Fase 5e-3)', () => {
  const blob = { v: 1 as const, salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y2lwaGVydGV4dA==' };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  it('sem backup 404; sem auth 401; corpo inválido 400; PUT guarda; GET devolve; DELETE remove', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/auth/e2ee-backup', headers: auth(agentToken) }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/e2ee-backup' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'PUT',
      url: '/auth/e2ee-backup',
      headers: auth(agentToken),
      payload: { v: 1, salt: 'x' }, // faltam iv/ct
    });
    expect(bad.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: '/auth/e2ee-backup',
      headers: auth(agentToken),
      payload: blob,
    });
    expect(put.statusCode).toBe(204);
    const got = await app.inject({
      method: 'GET',
      url: '/auth/e2ee-backup',
      headers: auth(agentToken),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject(blob);
    const del = await app.inject({
      method: 'DELETE',
      url: '/auth/e2ee-backup',
      headers: auth(agentToken),
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/auth/e2ee-backup', headers: auth(agentToken) }))
        .statusCode,
    ).toBe(404);
  });

  it('isolamento: o backup de um usuário não vaza para outro (escopo por token)', async () => {
    await app.inject({ method: 'PUT', url: '/auth/e2ee-backup', headers: auth(token), payload: blob });
    // o agente (outro usuário) vê o SEU backup (404, não tem) — nunca o do admin.
    expect(
      (await app.inject({ method: 'GET', url: '/auth/e2ee-backup', headers: auth(agentToken) }))
        .statusCode,
    ).toBe(404);
    // o admin continua vendo o dele.
    expect(
      (await app.inject({ method: 'GET', url: '/auth/e2ee-backup', headers: auth(token) })).statusCode,
    ).toBe(200);
    await app.inject({ method: 'DELETE', url: '/auth/e2ee-backup', headers: auth(token) });
  });
});
