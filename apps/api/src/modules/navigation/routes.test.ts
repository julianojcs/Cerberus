import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

/**
 * Integração das rotas de navegação (issue #131) via `app.inject()`, com Mongo em
 * memória e a ponte MQTT desligada. O provedor de rotas é stubado no `fetch` global —
 * a suíte nunca toca o OSRM público (sem rede nos testes, e não se bate em serviço
 * de terceiro em CI).
 */
let mongod: MongoMemoryServer;
let app: FastifyInstance;
let operationId: string;
let adminToken: string;
let agentToken: string;
let otherAgentToken: string;

const AGENT = 'AG-0456';
const OTHER_AGENT = 'AG-0999';
const ORIGIN: [number, number] = [-43.9386, -19.9319]; // Praça Sete, Belo Horizonte
const DESTINATION = { lat: -19.9245, lng: -43.9352 };

/** Resposta mínima do OSRM no formato que o adaptador consome. */
function osrmOk() {
  return {
    ok: true,
    json: async () => ({
      code: 'Ok',
      routes: [
        {
          distance: 1200,
          duration: 300,
          geometry: {
            coordinates: [ORIGIN, [-43.937, -19.928], [DESTINATION.lng, DESTINATION.lat]],
          },
          legs: [
            {
              steps: [
                {
                  distance: 700,
                  duration: 180,
                  name: 'Avenida Afonso Pena',
                  maneuver: { type: 'depart', location: ORIGIN },
                },
                {
                  distance: 500,
                  duration: 120,
                  name: 'Rua da Bahia',
                  maneuver: { type: 'turn', modifier: 'left', location: [-43.937, -19.928] },
                },
              ],
            },
          ],
        },
      ],
    }),
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongod.getUri('cerberus_nav');
  process.env.MQTT_BROKER_URL = 'mqtt://localhost:1883'; // exigido pelo env; não conecta
  process.env.JWT_SECRET = 'test_secret_1234567890';

  const { buildApp } = await import('../../app.js');
  const { User, Operation, Position } = await import('../../models/index.js');

  app = await buildApp({ withMqtt: false });

  const op = await Operation.create({ name: 'Op Navegação', type: 'escolta', status: 'ativa' });
  operationId = String(op._id);

  await User.create({
    username: 'admin_nav',
    name: 'Central',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'admin',
    operationIds: [op._id],
  });
  await User.create({
    username: 'agente_nav',
    name: 'Agente',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'agente',
    agentId: AGENT,
    operationIds: [op._id],
  });
  await User.create({
    username: 'agente_outro',
    name: 'Outro Agente',
    passwordHash: await bcrypt.hash('cerberus123', 10),
    role: 'agente',
    agentId: OTHER_AGENT,
    operationIds: [op._id],
  });

  const login = async (username: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username, password: 'cerberus123' },
    });
    return res.json().token;
  };
  adminToken = await login('admin_nav');
  agentToken = await login('agente_nav');
  otherAgentToken = await login('agente_outro');

  // Origem: a rota parte da última posição conhecida do agente, não de um ponto do corpo.
  await Position.create({
    operationId,
    agentId: AGENT,
    location: { type: 'Point', coordinates: ORIGIN },
    capturedAt: new Date('2026-07-18T12:00:00Z'),
    receivedAt: new Date(),
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await mongod?.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('despacho de rota pela central', () => {
  it('admin cria rota → 201 com geometria, passos em pt-BR e ETA', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION, label: 'Ponto de encontro' },
    });
    expect(res.statusCode).toBe(201);
    const route = res.json();
    expect(route.status).toBe('ativa');
    expect(route.source).toBe('central');
    expect(route.profile).toBe('driving');
    expect(route.fallback).toBe(false);
    expect(route.destination).toMatchObject({ ...DESTINATION, label: 'Ponto de encontro' });
    expect(route.geometry.length).toBeGreaterThan(1);
    expect(route.steps[0].instruction).toBe('Siga pela Avenida Afonso Pena');
    expect(route.steps[1].instruction).toBe('Vire à esquerda na Rua da Bahia');
    expect(route.distanceMeters).toBe(1200);
    // Barramento desligado nos testes: a rota persiste e o app a recupera em /active.
    expect(route.dispatched).toBe(false);
  });

  it('usa a última posição do agente como origem (não aceita origem do cliente)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(osrmOk());
    vi.stubGlobal('fetch', fetchMock);

    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      // Uma origem forjada no corpo deve ser simplesmente ignorada.
      payload: { agentId: AGENT, ...DESTINATION, lngOrigin: 0, latOrigin: 0 },
    });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`${ORIGIN[0]},${ORIGIN[1]};`);
  });

  it('agente sem posição conhecida → 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: OTHER_AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(409);
  });

  it('coordenada fora de faixa → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, lat: 120, lng: -43.9 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('operação fora do escopo → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operations/000000000000000000000000/routes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('provedor de rotas indisponível', () => {
  it('cai na linha reta e marca fallback (não deixa o operador sem rota)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(201);
    const route = res.json();
    expect(route.fallback).toBe(true);
    expect(route.geometry).toHaveLength(2); // origem → destino, sem malha viária
    expect(route.steps[0].instruction).toContain('sem dados de via');
  });

  it('resposta HTTP de erro do provedor também vira fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fallback).toBe(true);
  });
});

describe('rota definida pelo próprio agente', () => {
  it('agente cria rota para si mesmo → 201 com source=agent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe('agent');
  });

  it('agente NÃO cria rota para outro agente → 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('ciclo de vida da rota', () => {
  it('rota nova aposenta a anterior (SUBSTITUIDA) — só uma ativa por agente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const { Route } = await import('../../models/index.js');

    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });
    await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { agentId: AGENT, ...DESTINATION },
    });

    const ativas = await Route.countDocuments({ operationId, agentId: AGENT, status: 'ativa' });
    expect(ativas).toBe(1);
    expect(
      await Route.countDocuments({ operationId, agentId: AGENT, status: 'substituida' }),
    ).toBeGreaterThan(0);
  });

  it('GET /routes/active devolve a rota ativa (recuperação após reconexão)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/${AGENT}/routes/active`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ativa');
  });

  it('agente não lê a rota ativa de outro agente → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/${AGENT}/routes/active`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('recálculo cria nova rota apontando para a anterior, mantendo o destino', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const active = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/${AGENT}/routes/active`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const previousId = active.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes/${previousId}/recalculate`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(201);
    const recalculated = res.json();
    expect(recalculated.recalculatedFrom).toBe(previousId);
    expect(recalculated.destination).toMatchObject(DESTINATION);
    expect(recalculated.id).not.toBe(previousId);

    // A anterior virou SUBSTITUIDA, não CANCELADA: o destino não foi abandonado.
    const { Route } = await import('../../models/index.js');
    const previous = await Route.findById(previousId).lean();
    expect(previous?.status).toBe('substituida');
  });

  it('não recalcula rota que já não está ativa → 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const { Route } = await import('../../models/index.js');
    const stale = await Route.findOne({ operationId, status: 'substituida' }).lean();

    const res = await app.inject({
      method: 'POST',
      url: `/operations/${operationId}/routes/${String(stale!._id)}/recalculate`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('cancela a rota ativa → 204 e some da consulta de ativa', async () => {
    const active = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/${AGENT}/routes/active`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const routeId = active.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/operations/${operationId}/routes/${routeId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/agents/${AGENT}/routes/active`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.statusCode).toBe(404);
  });

  it('identificador malformado → 400 (não vaza erro do Mongo)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/routes/nao-e-objectid`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exige autenticação (401 sem token)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/routes`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('acompanhamento na ponte de ingest (chegada e desvio)', () => {
  /** Cria uma rota ativa direto no banco, com o traçado controlado pelo teste. */
  async function seedActiveRoute(overrides: Record<string, unknown> = {}) {
    const { Route } = await import('../../models/index.js');
    await Route.updateMany(
      { operationId, agentId: AGENT, status: 'ativa' },
      { $set: { status: 'substituida' } },
    );
    return Route.create({
      operationId,
      agentId: AGENT,
      source: 'central',
      status: 'ativa',
      profile: 'driving',
      destination: { type: 'Point', coordinates: [-43.93, -19.93] },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-43.94, -19.93],
          [-43.93, -19.93],
        ],
      },
      steps: [],
      distanceMeters: 1000,
      durationSec: 200,
      ...overrides,
    });
  }

  async function track(point: { lng: number; lat: number }) {
    const { trackRouteProgress } = await import('./track.js');
    const { OsrmRoutingProvider } = await import('./provider.js');
    await trackRouteProgress(
      {
        log: app.log,
        mqtt: undefined, // barramento fora: o comando não sai, a persistência continua
        provider: new OsrmRoutingProvider('http://stub'),
      },
      operationId,
      AGENT,
      point,
      '2026-07-18T13:00:00Z',
    );
  }

  it('chegar ao destino conclui a rota', async () => {
    const { Route } = await import('../../models/index.js');
    const route = await seedActiveRoute();
    await track({ lng: -43.93, lat: -19.93 });
    expect((await Route.findById(route._id).lean())?.status).toBe('concluida');
  });

  it('um desvio isolado NÃO recalcula (absorve GPS ruim)', async () => {
    const { Route } = await import('../../models/index.js');
    const route = await seedActiveRoute();
    await track({ lng: -43.935, lat: -19.932 }); // ~220 m fora do traçado

    const after = await Route.findById(route._id).lean();
    expect(after?.status).toBe('ativa');
    expect(after?.deviationStrikes).toBe(1);
  });

  it('voltar ao traçado zera os desvios acumulados', async () => {
    const { Route } = await import('../../models/index.js');
    const route = await seedActiveRoute();
    await track({ lng: -43.935, lat: -19.932 });
    await track({ lng: -43.935, lat: -19.93 }); // de volta à rota

    expect((await Route.findById(route._id).lean())?.deviationStrikes).toBe(0);
  });

  it('dois desvios seguidos recalculam e substituem a rota', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(osrmOk()));
    const { Route } = await import('../../models/index.js');
    const route = await seedActiveRoute();

    await track({ lng: -43.935, lat: -19.932 });
    await track({ lng: -43.935, lat: -19.933 });

    expect((await Route.findById(route._id).lean())?.status).toBe('substituida');
    const nova = await Route.findOne({ operationId, agentId: AGENT, status: 'ativa' }).lean();
    expect(String(nova?.recalculatedFrom)).toBe(String(route._id));
  });

  it('rota de fallback nunca dispara recálculo (evitaria laço infinito)', async () => {
    const { Route } = await import('../../models/index.js');
    // A linha reta ignora as ruas: um agente dirigindo fica sempre "fora" dela.
    const route = await seedActiveRoute({ fallback: true });

    await track({ lng: -43.935, lat: -19.932 });
    await track({ lng: -43.935, lat: -19.933 });

    const after = await Route.findById(route._id).lean();
    expect(after?.status).toBe('ativa');
    expect(after?.deviationStrikes).toBe(0);
  });

  it('sem rota ativa o acompanhamento é inócuo (não lança)', async () => {
    const { Route } = await import('../../models/index.js');
    await Route.updateMany(
      { operationId, agentId: AGENT, status: 'ativa' },
      { $set: { status: 'cancelada' } },
    );
    await expect(track({ lng: -43.9, lat: -19.9 })).resolves.toBeUndefined();
  });
});

describe('listagem de rotas', () => {
  it('agente só enxerga as próprias rotas', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/routes?status=todas`,
      headers: { authorization: `Bearer ${otherAgentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rotas = res.json() as Array<{ agentId: string }>;
    expect(rotas.every((r) => r.agentId === OTHER_AGENT)).toBe(true);
  });

  it('admin enxerga as rotas da operação', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/operations/${operationId}/routes?status=todas`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
  });
});
