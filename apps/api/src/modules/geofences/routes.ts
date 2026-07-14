import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Types } from 'mongoose';
import { GeofenceShape, Role } from '@cerberus/shared';
import { Alert, Geofence, GeofenceMembership, Position } from '../../models/index.js';
import { detectGeofenceEvents, type GeofenceLike } from './detect.js';
import { assertOperationScope } from '../scope.js';

// Cor = token de familia da paleta Tailwind (o dashboard restringe as opcoes).
const colorSchema = z
  .string()
  .regex(/^[a-z]+$/)
  .max(30);

const shapes = Object.values(GeofenceShape) as [string, ...string[]];
const lngSchema = z.number().min(-180).max(180);
const latSchema = z.number().min(-90).max(90);
const vertexSchema = z.tuple([lngSchema, latSchema]);

/** Base (círculo/retângulo/polígono) — geometria por forma, validada no superRefine. */
const geometryFields = {
  lng: lngSchema.optional(),
  lat: latSchema.optional(),
  radiusMeters: z.number().min(1).max(100000).optional(),
  widthMeters: z.number().min(1).max(200000).optional(),
  heightMeters: z.number().min(1).max(200000).optional(),
  rotationDeg: z.number().min(-360).max(360).optional(),
  vertices: z.array(vertexSchema).min(3).max(500).optional(),
  color: colorSchema.optional(),
};

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    shape: z.enum(shapes).default(GeofenceShape.CIRCLE),
    ...geometryFields,
  })
  .superRefine((d, ctx) => {
    if (d.shape === GeofenceShape.CIRCLE && (d.lng == null || d.lat == null || d.radiusMeters == null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Círculo exige lng/lat/radiusMeters' });
    if (
      d.shape === GeofenceShape.RECTANGLE &&
      (d.lng == null || d.lat == null || d.widthMeters == null || d.heightMeters == null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retângulo exige lng/lat/widthMeters/heightMeters',
      });
    if (d.shape === GeofenceShape.POLYGON && (!d.vertices || d.vertices.length < 3))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Polígono exige vertices (≥3)' });
  });

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  shape: z.enum(shapes).optional(),
  ...geometryFields,
});

/** Centroide de um anel de vértices (âncora/center do polígono). */
function centroid(vertices: number[][]): [number, number] {
  let lng = 0;
  let lat = 0;
  for (const v of vertices) {
    lng += v[0] ?? 0;
    lat += v[1] ?? 0;
  }
  return [lng / vertices.length, lat / vertices.length];
}

/** GeoJSON Point de âncora: [lng,lat] (círculo/retângulo) ou centroide (polígono). */
function centerFor(d: {
  shape?: string;
  lng?: number;
  lat?: number;
  vertices?: number[][];
}): { type: 'Point'; coordinates: number[] } | undefined {
  if (d.shape === GeofenceShape.POLYGON && d.vertices)
    return { type: 'Point', coordinates: centroid(d.vertices) };
  if (d.lng != null && d.lat != null) return { type: 'Point', coordinates: [d.lng, d.lat] };
  return undefined;
}

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
        shape: body.data.shape,
        center: centerFor(body.data),
        radiusMeters: body.data.radiusMeters,
        widthMeters: body.data.widthMeters,
        heightMeters: body.data.heightMeters,
        rotationDeg: body.data.rotationDeg,
        vertices: body.data.vertices,
        color: body.data.color ?? 'green',
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

  // Editar geofence (mover centro / redimensionar raio / renomear) — admin.
  app.patch(
    '/operations/:id/geofences/:gid',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, gid } = request.params as { id: string; gid: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(gid)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const body = patchSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const update: Record<string, unknown> = {};
      if (body.data.name !== undefined) update.name = body.data.name;
      if (body.data.shape !== undefined) update.shape = body.data.shape;
      if (body.data.radiusMeters !== undefined) update.radiusMeters = body.data.radiusMeters;
      if (body.data.widthMeters !== undefined) update.widthMeters = body.data.widthMeters;
      if (body.data.heightMeters !== undefined) update.heightMeters = body.data.heightMeters;
      if (body.data.rotationDeg !== undefined) update.rotationDeg = body.data.rotationDeg;
      if (body.data.color !== undefined) update.color = body.data.color;
      // Polígono: vertices + center = centroide. (Tem precedência sobre lng/lat abaixo.)
      if (body.data.vertices !== undefined) {
        update.vertices = body.data.vertices;
        update.center = { type: 'Point', coordinates: centroid(body.data.vertices) };
      } else if (body.data.lng !== undefined && body.data.lat !== undefined) {
        update.center = { type: 'Point', coordinates: [body.data.lng, body.data.lat] };
      }

      const g = await Geofence.findOneAndUpdate(
        { _id: gid, operationId: id },
        { $set: update },
        { new: true },
      );
      if (!g) return reply.code(404).send({ error: 'Geofence não encontrada' });
      return serializeGeofence(g.toObject());
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

  // Recalcula os alertas reprocessando TODO o histórico de posições contra as
  // zonas ativas (replay). Útil após criar/mover zonas: gera os alertas de
  // entrada/saída que ocorreram no passado. Admin, escopado.
  app.post(
    '/operations/:id/geofences/recompute',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      // Recomeça do zero para o replay ser determinístico.
      await Alert.deleteMany({ operationId: id });
      await GeofenceMembership.deleteMany({ operationId: id });

      // Cast: o typing lean do Mongoose p/ arrays aninhados (vertices) não casa com
      // GeofenceLike, mas os dados em runtime são corretos.
      const geofences = (await Geofence.find({ operationId: id, active: true })
        .lean()) as unknown as GeofenceLike[];
      if (geofences.length === 0) return { alertsCreated: 0 };

      const positions = await Position.find({ operationId: id }).sort({ capturedAt: 1 }).lean();
      const stateByAgent: Record<string, Record<string, boolean>> = {};
      const alerts: Record<string, unknown>[] = [];

      for (const p of positions) {
        const coords = (p.location as { coordinates?: number[] } | undefined)?.coordinates;
        const [lng, lat] = coords ?? [];
        if (lng == null || lat == null) continue;
        const insideBefore = (stateByAgent[p.agentId] ??= {});
        const events = detectGeofenceEvents({ lng, lat }, insideBefore, geofences);
        for (const ev of events) {
          insideBefore[ev.geofenceId] = ev.inside;
          alerts.push({
            operationId: id,
            agentId: p.agentId,
            geofenceId: ev.geofenceId,
            geofenceName: ev.geofenceName,
            type: ev.type,
            location: { type: 'Point', coordinates: [lng, lat] },
            capturedAt: p.capturedAt,
            receivedAt: new Date(),
          });
        }
      }
      if (alerts.length > 0) await Alert.insertMany(alerts);

      // Persiste o estado final de pertencimento (para a detecção ao vivo continuar).
      const memberships: Record<string, unknown>[] = [];
      for (const [agentId, map] of Object.entries(stateByAgent)) {
        for (const [geofenceId, inside] of Object.entries(map)) {
          memberships.push({ operationId: id, agentId, geofenceId, inside, updatedAt: new Date() });
        }
      }
      if (memberships.length > 0) await GeofenceMembership.insertMany(memberships);

      return { alertsCreated: alerts.length };
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
    shape: (g.shape as string | undefined) ?? 'circle', // retrocompat: docs antigos sem shape
    lng: center?.coordinates?.[0],
    lat: center?.coordinates?.[1],
    radiusMeters: g.radiusMeters,
    widthMeters: g.widthMeters,
    heightMeters: g.heightMeters,
    rotationDeg: g.rotationDeg,
    vertices: g.vertices,
    color: g.color ?? 'green',
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
