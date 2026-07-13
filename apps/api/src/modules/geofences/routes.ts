import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Role } from '@cerberus/shared';
import { Alert, Geofence, GeofenceMembership, Position } from '../../models/index.js';
import { detectGeofenceEvents, haversineMeters } from './detect.js';
import { assertOperationScope } from '../scope.js';

// Cor = token de familia da paleta Tailwind (o dashboard restringe as opcoes).
const colorSchema = z
  .string()
  .regex(/^[a-z]+$/)
  .max(30);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  radiusMeters: z.number().min(1).max(100000),
  color: colorSchema.optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  lng: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-90).max(90).optional(),
  radiusMeters: z.number().min(1).max(100000).optional(),
  color: colorSchema.optional(),
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
        color: body.data.color ?? 'green',
      });

      // Semeia o pertencimento dos agentes que JÁ estão dentro da zona no momento da
      // criação (inside=true, SEM alerta). Assim, criar uma zona em volta de um agente
      // que já está lá NÃO dispara um "enter" espúrio na próxima posição — ele não
      // entrou, já estava dentro. Só cruzamentos POSTERIORES geram enter/exit.
      const gid = String(g._id);
      const center = { lng: body.data.lng, lat: body.data.lat };
      const latest = await Position.aggregate([
        { $match: { operationId: id } },
        { $sort: { capturedAt: -1 } },
        { $group: { _id: '$agentId', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ]);
      const seeds = latest
        .map((p) => {
          const coords = (p.location as { coordinates?: number[] } | undefined)?.coordinates ?? [];
          const [lng, lat] = coords;
          if (lng == null || lat == null) return null;
          if (haversineMeters(center, { lng, lat }) > body.data.radiusMeters) return null;
          return {
            operationId: id,
            agentId: p.agentId as string,
            geofenceId: gid,
            inside: true,
            updatedAt: new Date(),
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      if (seeds.length > 0) await GeofenceMembership.insertMany(seeds);

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
      if (body.data.radiusMeters !== undefined) update.radiusMeters = body.data.radiusMeters;
      if (body.data.color !== undefined) update.color = body.data.color;
      if (body.data.lng !== undefined && body.data.lat !== undefined) {
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

  // Recalcula os alertas reprocessando o histórico de posições contra as zonas
  // ativas (replay). Uma zona só "existe" a partir do seu createdAt: posições
  // ANTERIORES apenas firmam a linha de base de pertencimento (sem alerta), então um
  // agente que já estava dentro quando a zona foi criada NÃO gera "enter" espúrio;
  // só cruzamentos a partir do createdAt viram enter/exit. Admin, escopado.
  app.post(
    '/operations/:id/geofences/recompute',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      // Recomeça do zero para o replay ser determinístico.
      await Alert.deleteMany({ operationId: id });
      await GeofenceMembership.deleteMany({ operationId: id });

      const geofences = await Geofence.find({ operationId: id, active: true }).lean();
      if (geofences.length === 0) return { alertsCreated: 0 };

      const positions = await Position.find({ operationId: id }).sort({ capturedAt: 1 }).lean();
      const stateByAgent: Record<string, Record<string, boolean>> = {};
      const alerts: Record<string, unknown>[] = [];

      // Instante de criação de cada zona (ela só "existe" a partir daí).
      const createdMs = new Map<string, number>();
      for (const g of geofences) createdMs.set(String(g._id), g.createdAt ? +new Date(g.createdAt) : 0);

      for (const p of positions) {
        const coords = (p.location as { coordinates?: number[] } | undefined)?.coordinates;
        const [lng, lat] = coords ?? [];
        if (lng == null || lat == null) continue;
        const capMs = +new Date(p.capturedAt);
        const insideBefore = (stateByAgent[p.agentId] ??= {});

        // Zonas ainda não criadas nesta posição: só firmam a linha de base (sem alerta),
        // para "já estar dentro na criação" não virar um "enter" espúrio depois.
        for (const g of geofences) {
          if (capMs >= (createdMs.get(String(g._id)) ?? 0)) continue;
          const gc = (g.center as { coordinates?: number[] } | undefined)?.coordinates ?? [];
          const [clng, clat] = gc;
          if (clng == null || clat == null) continue;
          insideBefore[String(g._id)] =
            haversineMeters({ lng, lat }, { lng: clng, lat: clat }) <= g.radiusMeters;
        }

        // Zonas já existentes nesta posição: detecção normal (gera enter/exit).
        const born = geofences.filter((g) => capMs >= (createdMs.get(String(g._id)) ?? 0));
        const events = detectGeofenceEvents({ lng, lat }, insideBefore, born);
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
    lng: center?.coordinates?.[0],
    lat: center?.coordinates?.[1],
    radiusMeters: g.radiusMeters,
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
