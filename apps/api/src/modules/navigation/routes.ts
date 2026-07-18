import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import {
  AgentCommandType,
  agentCommandTopic,
  createRouteSchema,
  Role,
  RouteProfile,
  RouteSource,
  RouteStatus,
  type AuthClaims,
  type RouteInfo,
  type RouteStep,
} from '@cerberus/shared';
import { Position, Route } from '../../models/index.js';
import { assertOperationScope, isSuperAdmin } from '../scope.js';
import { computeRouteWithFallback, OsrmRoutingProvider } from './provider.js';

/**
 * Navegação por rota (issue #131) — despacho de destino e ciclo de vida da rota.
 *
 * O módulo se chama `navigation` e não `routes` de propósito: em
 * `apps/dashboard/src/lib/routes.ts` "rota" já significa o rastro JÁ percorrido. Aqui
 * é o trajeto PLANEJADO. Misturar os dois nomes é a confusão mais provável desta feature.
 */

/** Quem está agindo: a central (admin/SA) despachando, ou o agente para si mesmo. */
interface Actor {
  source: RouteSource;
  /** Agente-alvo permitido; `null` = central, pode mirar qualquer agente. */
  ownAgentId: string | null;
  userId: string;
}

function resolveActor(claims: AuthClaims): Actor {
  const isCentral = isSuperAdmin(claims) || claims.role === Role.ADMIN;
  return {
    source: isCentral ? RouteSource.CENTRAL : RouteSource.AGENT,
    ownAgentId: isCentral ? null : (claims.agentId ?? ''),
    userId: claims.sub,
  };
}

export async function navigationRoutes(app: FastifyInstance): Promise<void> {
  const provider = new OsrmRoutingProvider(app.env.OSRM_BASE_URL, app.env.ROUTING_TIMEOUT_MS);

  /**
   * Cria a rota até o destino e despacha para o agente.
   *
   * Admin/SA despacham para qualquer agente da operação; o agente pode criar rota
   * apenas para SI MESMO (destino escolhido no próprio app). A ORIGEM nunca vem do
   * corpo: é a última posição conhecida do agente, que o servidor já tem — aceitar
   * origem do cliente permitiria traçar a partir de onde o agente não está.
   */
  app.post('/operations/:id/routes', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;

    const body = createRouteSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

    const actor = resolveActor(request.user as AuthClaims);
    if (actor.ownAgentId !== null && actor.ownAgentId !== body.data.agentId) {
      return reply.code(403).send({ error: 'Um agente só define rota para si mesmo' });
    }

    const origin = await lastKnownPosition(id, body.data.agentId);
    if (!origin) {
      return reply.code(409).send({ error: 'Agente sem posição conhecida para iniciar a rota' });
    }

    const destination = { lng: body.data.lng, lat: body.data.lat };
    const computed = await computeRouteWithFallback(provider, origin, destination);

    // Uma rota nova aposenta a anterior ANTES de nascer: sem isso o agente ficaria com
    // duas rotas "ativas" e a detecção de desvio não saberia qual traçado seguir.
    await supersedeActive(id, body.data.agentId);

    const route = await Route.create({
      operationId: id,
      agentId: body.data.agentId,
      source: actor.source,
      status: RouteStatus.ATIVA,
      profile: RouteProfile.DRIVING,
      destination: { type: 'Point', coordinates: [destination.lng, destination.lat] },
      destinationLabel: body.data.label,
      geometry: { type: 'LineString', coordinates: computed.geometry },
      steps: computed.steps,
      distanceMeters: computed.distanceMeters,
      durationSec: computed.durationSec,
      fallback: computed.fallback,
      createdBy: actor.userId,
    });

    const dispatched = dispatch(app, id, body.data.agentId, AgentCommandType.ROUTE_ASSIGN,
      String(route._id));

    // 201 mesmo com o barramento fora: a rota fica persistida e o app a encontra em
    // `GET .../routes/active` ao reconectar. Falhar aqui perderia o trabalho de cálculo
    // por uma indisponibilidade que o próprio app sabe contornar.
    return reply.code(201).send({ ...serializeRoute(route.toObject()), dispatched });
  });

  /** Rota completa — é o que o app busca após receber o ponteiro no comando MQTT. */
  app.get(
    '/operations/:id/routes/:routeId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, routeId } = request.params as { id: string; routeId: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(routeId)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const route = await Route.findOne({ _id: routeId, operationId: id }).lean();
      if (!route) return reply.code(404).send({ error: 'Rota não encontrada' });

      // Um agente não lê a rota de outro: o comando chegou no subtópico dele, então o
      // ponteiro é dele. Admin/SA leem todas (precisam plotar a operação inteira).
      const actor = resolveActor(request.user as AuthClaims);
      if (actor.ownAgentId !== null && actor.ownAgentId !== route.agentId) {
        return reply.code(403).send({ error: 'Rota de outro agente' });
      }
      return serializeRoute(route);
    },
  );

  /** Rota ativa do agente — usada pelo app na reconexão (recupera despacho perdido). */
  app.get(
    '/operations/:id/agents/:agentId/routes/active',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, agentId } = request.params as { id: string; agentId: string };
      if (!assertOperationScope(request, reply, id)) return;

      const actor = resolveActor(request.user as AuthClaims);
      if (actor.ownAgentId !== null && actor.ownAgentId !== agentId) {
        return reply.code(403).send({ error: 'Rota de outro agente' });
      }
      const route = await Route.findOne({
        operationId: id,
        agentId,
        status: RouteStatus.ATIVA,
      })
        .sort({ createdAt: -1 })
        .lean();
      if (!route) return reply.code(404).send({ error: 'Nenhuma rota ativa' });
      return serializeRoute(route);
    },
  );

  /** Rotas da operação (painel do operador). `?status=` filtra; padrão = só as ativas. */
  app.get('/operations/:id/routes', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
    const { status } = request.query as { status?: string };

    const filter: Record<string, unknown> = { operationId: id };
    if (status !== 'todas') filter.status = status ?? RouteStatus.ATIVA;

    const actor = resolveActor(request.user as AuthClaims);
    if (actor.ownAgentId !== null) filter.agentId = actor.ownAgentId;

    const docs = await Route.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return docs.map(serializeRoute);
  });

  /** Cancela a rota (central ou o próprio agente) e avisa o app. */
  app.delete(
    '/operations/:id/routes/:routeId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, routeId } = request.params as { id: string; routeId: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(routeId)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const actor = resolveActor(request.user as AuthClaims);
      const filter: Record<string, unknown> = { _id: routeId, operationId: id };
      if (actor.ownAgentId !== null) filter.agentId = actor.ownAgentId;

      const route = await Route.findOneAndUpdate(
        { ...filter, status: RouteStatus.ATIVA },
        { $set: { status: RouteStatus.CANCELADA } },
        { new: true },
      );
      if (!route) return reply.code(404).send({ error: 'Rota ativa não encontrada' });

      dispatch(app, id, route.agentId, AgentCommandType.ROUTE_CANCEL, String(route._id));
      return reply.code(204).send();
    },
  );

  /**
   * Recalcula a rota a partir da posição ATUAL do agente, mantendo o destino. É o que
   * o app chama quando detecta desvio. A rota antiga vira `SUBSTITUIDA` (não
   * `CANCELADA`): ninguém desistiu do destino, o trajeto é que mudou — e o histórico
   * precisa distinguir as duas coisas.
   */
  app.post(
    '/operations/:id/routes/:routeId/recalculate',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, routeId } = request.params as { id: string; routeId: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(routeId)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const previous = await Route.findOne({ _id: routeId, operationId: id }).lean();
      if (!previous) return reply.code(404).send({ error: 'Rota não encontrada' });

      const actor = resolveActor(request.user as AuthClaims);
      if (actor.ownAgentId !== null && actor.ownAgentId !== previous.agentId) {
        return reply.code(403).send({ error: 'Rota de outro agente' });
      }
      if (previous.status !== RouteStatus.ATIVA) {
        return reply.code(409).send({ error: 'Só uma rota ativa pode ser recalculada' });
      }

      const origin = await lastKnownPosition(id, previous.agentId);
      if (!origin) {
        return reply.code(409).send({ error: 'Agente sem posição conhecida para recalcular' });
      }
      const [dLng, dLat] = previous.destination?.coordinates ?? [];
      if (dLng == null || dLat == null) {
        return reply.code(409).send({ error: 'Rota sem destino válido' });
      }
      const destination = { lng: dLng, lat: dLat };
      const computed = await computeRouteWithFallback(provider, origin, destination);

      await supersedeActive(id, previous.agentId);
      const route = await Route.create({
        operationId: id,
        agentId: previous.agentId,
        source: previous.source,
        status: RouteStatus.ATIVA,
        profile: RouteProfile.DRIVING,
        destination: { type: 'Point', coordinates: [destination.lng, destination.lat] },
        destinationLabel: previous.destinationLabel,
        geometry: { type: 'LineString', coordinates: computed.geometry },
        steps: computed.steps,
        distanceMeters: computed.distanceMeters,
        durationSec: computed.durationSec,
        fallback: computed.fallback,
        recalculatedFrom: String(previous._id),
        createdBy: actor.userId,
      });

      const dispatched = dispatch(app, id, previous.agentId, AgentCommandType.ROUTE_ASSIGN,
        String(route._id));
      return reply.code(201).send({ ...serializeRoute(route.toObject()), dispatched });
    },
  );
}

/* ------------------------------------------------------------------ Helpers */

/** Última posição conhecida do agente na operação — origem de qualquer cálculo. */
async function lastKnownPosition(
  operationId: string,
  agentId: string,
): Promise<{ lng: number; lat: number } | null> {
  const last = await Position.findOne({ operationId, agentId })
    .sort({ capturedAt: -1 })
    .select('location')
    .lean();
  const [lng, lat] = last?.location?.coordinates ?? [];
  return lng != null && lat != null ? { lng, lat } : null;
}

/** Aposenta as rotas ativas do agente (uma rota nova ou recalculada substitui a anterior). */
async function supersedeActive(operationId: string, agentId: string): Promise<void> {
  await Route.updateMany(
    { operationId, agentId, status: RouteStatus.ATIVA },
    { $set: { status: RouteStatus.SUBSTITUIDA } },
  );
}

/**
 * Publica o comando no canal do agente. Fire-and-forget: retorna se FOI EMITIDO, não
 * se o agente recebeu. O payload leva só o `routeId` — o traçado é buscado por HTTPS
 * (ver .claude/rules/mqtt-multitenant.md, canal `comando`).
 */
function dispatch(
  app: FastifyInstance,
  operationId: string,
  agentId: string,
  type: AgentCommandType,
  routeId: string,
): boolean {
  if (!app.mqtt?.connected) return false;
  app.mqtt.publish(
    agentCommandTopic(operationId, agentId),
    JSON.stringify({ type, routeId }),
    { qos: 1 },
  );
  return true;
}

function serializeRoute(r: Record<string, unknown>): RouteInfo {
  const destination = r.destination as { coordinates?: number[] } | undefined;
  const geometry = r.geometry as { coordinates?: [number, number][] } | undefined;
  const [lng, lat] = destination?.coordinates ?? [];
  return {
    id: String(r._id),
    operationId: String(r.operationId),
    agentId: String(r.agentId),
    source: r.source as RouteInfo['source'],
    status: r.status as RouteInfo['status'],
    profile: (r.profile as RouteInfo['profile']) ?? RouteProfile.DRIVING,
    destination: {
      lng: lng ?? 0,
      lat: lat ?? 0,
      label: (r.destinationLabel as string | undefined) ?? undefined,
    },
    geometry: geometry?.coordinates ?? [],
    steps: (r.steps as RouteStep[] | undefined) ?? [],
    distanceMeters: (r.distanceMeters as number | undefined) ?? 0,
    durationSec: (r.durationSec as number | undefined) ?? 0,
    fallback: (r.fallback as boolean | undefined) ?? false,
    recalculatedFrom: (r.recalculatedFrom as string | null | undefined) ?? undefined,
    createdAt:
      (r.createdAt as Date | undefined)?.toISOString?.() ?? new Date(0).toISOString(),
    createdBy: r.createdBy ? String(r.createdBy) : undefined,
  };
}
