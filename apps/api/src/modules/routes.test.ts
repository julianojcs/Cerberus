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

  it('replay é ciente do createdAt: cruzamento após criação gera enter+exit; já-dentro-na-criação não gera enter', async () => {
    const { Geofence, Position } = await import('../models/index.js');
    const gf = await Geofence.create({
      operationId,
      name: 'ZonaReplay',
      center: { type: 'Point', coordinates: [-43.9, -19.9] },
      radiusMeters: 150,
      color: 'blue',
    });
    const created = gf.createdAt as Date;
    const inside = { type: 'Point' as const, coordinates: [-43.9, -19.9] };
    const outside = { type: 'Point' as const, coordinates: [-43.8, -19.8] };
    const at = (deltaMs: number) => new Date(created.getTime() + deltaMs);

    // AG-REPLAY: cruza PARA DENTRO e depois PARA FORA, ambos APÓS a criação da zona
    // → deve gerar enter + exit.
    await Position.create({ operationId, agentId: 'AG-REPLAY', location: inside, capturedAt: at(60_000), receivedAt: new Date() });
    await Position.create({ operationId, agentId: 'AG-REPLAY', location: outside, capturedAt: at(120_000), receivedAt: new Date() });

    // AG-INSIDE: já estava DENTRO quando a zona foi criada (posição ANTES do createdAt)
    // → não deve gerar enter; ao sair depois, gera só exit.
    await Position.create({ operationId, agentId: 'AG-INSIDE', location: inside, capturedAt: at(-60_000), receivedAt: new Date() });
    await Position.create({ operationId, agentId: 'AG-INSIDE', location: inside, capturedAt: at(60_000), receivedAt: new Date() });
    await Position.create({ operationId, agentId: 'AG-INSIDE', location: outside, capturedAt: at(120_000), receivedAt: new Date() });

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/geofences/recompute`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const alerts = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/alerts`,
      headers: { authorization: `Bearer ${token}` },
    });
    const typesOf = (agentId: string) =>
      (alerts.json() as Array<{ type: string; agentId: string }>)
        .filter((a) => a.agentId === agentId)
        .map((a) => a.type);

    // Cruzou após a criação → enter + exit.
    expect(typesOf('AG-REPLAY')).toEqual(expect.arrayContaining(['enter', 'exit']));
    // Já estava dentro na criação → sem "enter" espúrio; só o exit ao sair.
    expect(typesOf('AG-INSIDE')).toContain('exit');
    expect(typesOf('AG-INSIDE')).not.toContain('enter');
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
});

describe('configurações do sistema', () => {
  it('GET /settings retorna os padrões (min 5, ligar rotas off, gap 5 min)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ minRoutePoints: 5, connectRoutes: false, maxGapMinutes: 5 });
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
