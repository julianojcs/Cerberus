import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Role, type AuthClaims } from '@cerberus/shared';
import { Team, User } from '../../models/index.js';
import { assertOperationScope, isSuperAdmin } from '../scope.js';

// Cor = token de família da paleta Tailwind (o dashboard restringe as opções).
const colorSchema = z
  .string()
  .regex(/^[a-z]+$/)
  .max(30);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  color: colorSchema.optional(),
  agentIds: z.array(z.string()).optional(),
  leadId: z.string().optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(120),
    color: colorSchema,
    agentIds: z.array(z.string()),
    // '' limpa o líder.
    leadId: z.string(),
  })
  .partial();

/** Conjunto de `agentId` dos agentes de campo da operação (base da validação ⊆). */
async function operationAgentIds(operationId: string): Promise<Set<string>> {
  const agents = await User.find({ operationIds: operationId, role: Role.AGENTE })
    .select('agentId')
    .lean();
  return new Set(agents.map((a) => a.agentId).filter((x): x is string => !!x));
}

/**
 * Equipes (Fase 2): sub-grupos de uma operação. CRUD restrito a admin (+ escopo da
 * operação; SA transcende). Toda query filtra por `operationId`. `agentIds` deve ser
 * subconjunto dos agentes da operação — senão quebraria o isolamento multitenant.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  // Lista as equipes da operação (escopado).
  app.get('/operations/:id/teams', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
    const docs = await Team.find({ operationId: id }).sort({ name: 1 }).lean();
    return docs.map(serialize);
  });

  // Cria uma equipe (admin + escopo).
  app.post(
    '/operations/:id/teams',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = createSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const agentIds = body.data.agentIds ?? [];
      const valid = await operationAgentIds(id);
      if (!agentIds.every((a) => valid.has(a))) {
        return reply.code(400).send({ error: 'Há agentes fora da operação' });
      }
      if (body.data.leadId && !agentIds.includes(body.data.leadId)) {
        return reply.code(400).send({ error: 'O líder deve ser um membro da equipe' });
      }

      const claims = request.user as AuthClaims;
      try {
        const team = await Team.create({
          operationId: id,
          name: body.data.name,
          color: body.data.color ?? 'blue',
          agentIds,
          leadId: body.data.leadId || undefined,
          createdBy: claims.sub,
        });
        return reply.code(201).send(serialize(team.toObject()));
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          return reply.code(409).send({ error: 'Já existe uma equipe com esse nome na operação' });
        }
        throw err;
      }
    },
  );

  // Atualiza uma equipe (admin + escopo). `agentIds` substitui o array.
  app.patch(
    '/operations/:id/teams/:tid',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, tid } = request.params as { id: string; tid: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(tid)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const body = patchSchema.safeParse(request.body);
      if (!body.success || Object.keys(body.data).length === 0) {
        return reply.code(400).send({ error: 'Dados inválidos' });
      }

      const current = await Team.findOne({ _id: tid, operationId: id }).lean();
      if (!current) return reply.code(404).send({ error: 'Equipe não encontrada' });

      const nextAgentIds = body.data.agentIds ?? (current.agentIds ?? []).map(String);
      if (body.data.agentIds !== undefined) {
        const valid = await operationAgentIds(id);
        if (!body.data.agentIds.every((a) => valid.has(a))) {
          return reply.code(400).send({ error: 'Há agentes fora da operação' });
        }
      }
      // Líder: '' limpa; qualquer valor precisa estar entre os membros finais.
      const nextLead = body.data.leadId === undefined ? current.leadId : body.data.leadId || null;
      if (nextLead && !nextAgentIds.includes(nextLead)) {
        return reply.code(400).send({ error: 'O líder deve ser um membro da equipe' });
      }

      const update: Record<string, unknown> = {};
      if (body.data.name !== undefined) update.name = body.data.name;
      if (body.data.color !== undefined) update.color = body.data.color;
      if (body.data.agentIds !== undefined) update.agentIds = body.data.agentIds;
      if (body.data.leadId !== undefined) update.leadId = body.data.leadId || null;

      try {
        const team = await Team.findOneAndUpdate(
          { _id: tid, operationId: id },
          { $set: update },
          { new: true },
        );
        if (!team) return reply.code(404).send({ error: 'Equipe não encontrada' });
        return serialize(team.toObject());
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          return reply.code(409).send({ error: 'Já existe uma equipe com esse nome na operação' });
        }
        throw err;
      }
    },
  );

  // Remove uma equipe (admin + escopo).
  app.delete(
    '/operations/:id/teams/:tid',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, tid } = request.params as { id: string; tid: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(tid)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const res = await Team.deleteOne({ _id: tid, operationId: id });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'Equipe não encontrada' });
      return reply.code(204).send();
    },
  );

  // Conveniência global: todas as equipes no escopo do usuário (SA = todas). Alimenta
  // o mapa global e a lista do painel Admin sem um fan-out por operação.
  app.get('/teams', { onRequest: [app.authenticate] }, async (request) => {
    const claims = request.user as AuthClaims;
    const filter = isSuperAdmin(claims)
      ? {}
      : { operationId: { $in: claims.operationIds } };
    const docs = await Team.find(filter).sort({ name: 1 }).lean();
    return docs.map(serialize);
  });
}

function serialize(t: {
  _id: unknown;
  operationId: string;
  name: string;
  color?: string | null;
  leadId?: string | null;
  agentIds?: string[];
  createdAt?: Date;
}) {
  return {
    id: String(t._id),
    operationId: t.operationId,
    name: t.name,
    color: t.color ?? 'blue',
    leadId: t.leadId ?? undefined,
    agentIds: (t.agentIds ?? []).map(String),
    createdAt: t.createdAt?.toISOString?.() ?? t.createdAt,
  };
}
