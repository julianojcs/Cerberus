import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Position } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const historyQuerySchema = z.object({
  agentId: z.string().optional(),
  limit: z.coerce.number().min(1).max(5000).default(500),
  since: z.string().datetime().optional(),
});

const nearbyQuerySchema = z.object({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  meters: z.coerce.number().min(1).max(100000).default(1000),
});

/**
 * Consultas históricas e geoespaciais de posições. A plotagem AO VIVO não passa
 * por aqui (o dashboard assina o broker MQTT diretamente); estas rotas servem
 * replay histórico e geofencing sobre o índice 2dsphere.
 */
export async function positionRoutes(app: FastifyInstance): Promise<void> {
  // Histórico de posições de uma operação (trilha), escopado por operação.
  app.get(
    '/operations/:id/positions',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const q = historyQuerySchema.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: 'Parâmetros inválidos' });

      const filter: Record<string, unknown> = { operationId: id };
      if (q.data.agentId) filter.agentId = q.data.agentId;
      if (q.data.since) filter.capturedAt = { $gte: new Date(q.data.since) };

      const docs = await Position.find(filter).sort({ capturedAt: -1 }).limit(q.data.limit).lean();
      return docs.map(serialize);
    },
  );

  // Última posição conhecida de cada agente da operação (snapshot ao entrar no mapa).
  app.get(
    '/operations/:id/positions/latest',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const docs = await Position.aggregate([
        { $match: { operationId: id } },
        { $sort: { capturedAt: -1 } },
        { $group: { _id: '$agentId', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ]);
      return docs.map(serialize);
    },
  );

  // Consulta de proximidade (geofencing) via índice 2dsphere.
  app.get(
    '/operations/:id/positions/nearby',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const q = nearbyQuerySchema.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: 'Parâmetros inválidos' });

      const docs = await Position.find({
        operationId: id,
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [q.data.lng, q.data.lat] },
            $maxDistance: q.data.meters,
          },
        },
      })
        .limit(500)
        .lean();
      return docs.map(serialize);
    },
  );
}

function serialize(doc: Record<string, unknown>) {
  const loc = doc.location as { coordinates: [number, number] } | undefined;
  return {
    id: String(doc._id),
    operationId: doc.operationId,
    agentId: doc.agentId,
    lng: loc?.coordinates?.[0],
    lat: loc?.coordinates?.[1],
    accuracy: doc.accuracy,
    speed: doc.speed,
    heading: doc.heading,
    battery: doc.battery,
    activity: doc.activity,
    capturedAt: (doc.capturedAt as Date | undefined)?.toISOString?.() ?? doc.capturedAt,
  };
}
