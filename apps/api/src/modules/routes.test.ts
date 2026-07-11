import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import FormData from 'form-data';
import type { FastifyInstance } from 'fastify';

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

describe('broadcast da central (admin → agentes)', () => {
  it('admin emite broadcast (POST /broadcast) persistido como tipo broadcast', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'CENTRAL: recolher ao ponto de encontro.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('broadcast');

    const hist = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    const broadcast = (hist.json() as Array<{ type: string; text: string }>).find(
      (m) => m.type === 'broadcast',
    );
    expect(broadcast?.text).toBe('CENTRAL: recolher ao ponto de encontro.');
  });

  it('agente (não-admin) não pode emitir broadcast (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { text: 'tentativa indevida' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('bloqueia broadcast em operação fora do escopo (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operations/000000000000000000000000/broadcast',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'fora do escopo' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejeita broadcast com texto vazio (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/broadcast`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: '' },
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

    // Mensagem real sob a operação B (via rota, exercitando também o write path).
    await app.inject({
      method: 'POST',
      url: `/operations/${opBId}/messages`,
      headers: { authorization: `Bearer ${tokenBravo}` },
      payload: { text: 'Bravo: perímetro seguro.' },
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
      payload: { text: 'Injeção indevida entre operações.' },
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
    const texts = (msgs.json() as Array<{ text: string }>).map((m) => m.text);
    expect(texts).toContain('Bravo: perímetro seguro.');
    expect(texts).not.toContain('Alvo avistado.'); // mensagem da operação A não vaza
  });
});

describe('mídia (GridFS)', () => {
  let mediaRef: string;

  it('agente faz upload de foto com legenda + geotag (POST /media) → 201', async () => {
    const form = new FormData();
    // Campos de texto ANTES do arquivo (para o multipart populá-los em file.fields).
    form.append('caption', 'Veículo suspeito na esquina.');
    form.append('lng', '-43.9386');
    form.append('lat', '-19.9319');
    form.append('file', PNG, { filename: 'foto.png', contentType: 'image/png' });
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
    expect(body.text).toBe('Veículo suspeito na esquina.');
    expect(body.lat).toBeCloseTo(-19.9319);
    expect(body.lng).toBeCloseTo(-43.9386);
    mediaRef = body.mediaRef;
  });

  it('histórico traz a mídia com legenda + geotag', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const media = (res.json() as Array<{ type: string; text?: string; lat?: number }>).find(
      (m) => m.type === 'media',
    );
    expect(media?.text).toBe('Veículo suspeito na esquina.');
    expect(media?.lat).toBeCloseTo(-19.9319);
  });

  it('faz stream do binário (GET /media/:fileId) → 200 image/png', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/media/${mediaRef}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBe(PNG.length);
  });

  it('rejeita tipo não suportado (415)', async () => {
    const form = new FormData();
    form.append('file', Buffer.from('texto'), { filename: 'a.txt', contentType: 'text/plain' });
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/media`,
      headers: { ...form.getHeaders(), authorization: `Bearer ${agentToken}` },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(415);
  });

  it('bloqueia upload em operação fora do escopo (403)', async () => {
    const form = new FormData();
    form.append('file', PNG, { filename: 'foto.png', contentType: 'image/png' });
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
