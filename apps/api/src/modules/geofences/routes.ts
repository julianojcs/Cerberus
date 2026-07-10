import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Role } from '@cerberus/shared';
import { Alert, Geofence } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  radiusMeters: z.number().min(1).max(100000),
});

/**
 * Geofencing (Fase 4): zonas circulares por operação. A criação/remoção é
 * restrita a admin; a listagem e os alertas são escopados por operação. A
 * detecção enter/exit acontece na ponte de ingest (plugins/mqtt.ts).
 */
export async function geofenceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/operations/:id/geofences',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = createSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const g = await Geofence.create({
        operationId: id,
        name: body.data.name,
        center: { type: 'Point', coordinates: [body.data.lng, body.data.lat] },
        radiusMeters: body.data.radiusMeters,
      });
      return reply.code(201).send(serializeGeofence(g.toObject()));
    },
  );

  app.get(
    '/operations/:id/geofences',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;
      const docs = await Geofence.find({ operationId: id }).lean();
      return docs.map(serializeGeofence);
    },
  );

  app.delete(
    '/operations/:id/geofences/:gid',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, gid } = request.params as { id: string; gid: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(gid)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const res = await Geofence.deleteOne({ _id: gid, operationId: id });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'Geofence não encontrada' });
      return reply.code(204).send();
    },
  );

  // Alertas de geofence da operação (mais recentes primeiro), escopados.
  app.get('/operations/:id/alerts', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
    const docs = await Alert.find({ operationId: id }).sort({ receivedAt: -1 }).limit(200).lean();
    return docs.map(serializeAlert);
  });
}

function serializeGeofence(g: Record<string, unknown>) {
  const center = g.center as { coordinates?: number[] } | undefined;
  return {
    id: String(g._id),
    operationId: g.operationId,
    name: g.name,
    lng: center?.coordinates?.[0],
    lat: center?.coordinates?.[1],
    radiusMeters: g.radiusMeters,
    active: g.active,
  };
}

function serializeAlert(a: Record<string, unknown>) {
  const loc = a.location as { coordinates?: number[] } | undefined;
  return {
    id: String(a._id),
    operationId: a.operationId,
    agentId: a.agentId,
    geofenceId: a.geofenceId,
    geofenceName: a.geofenceName,
    type: a.type,
    lng: loc?.coordinates?.[0],
    lat: loc?.coordinates?.[1],
    capturedAt: (a.capturedAt as Date | undefined)?.toISOString?.() ?? a.capturedAt,
  };
}
