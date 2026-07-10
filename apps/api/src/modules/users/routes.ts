import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Role } from '@cerberus/shared';
import { User } from '../../models/index.js';

const roles = Object.values(Role) as [string, ...string[]];

const createUserSchema = z.object({
  username: z.string().min(3),
  name: z.string().min(1),
  password: z.string().min(6),
  role: z.enum(roles),
  agentId: z.string().min(1).optional(),
  operationIds: z.array(z.string()).optional(),
});

/** Atualização parcial — pelo menos um campo deve ser enviado. */
const updateUserSchema = z
  .object({
    name: z.string().min(1),
    role: z.enum(roles),
    agentId: z.string().min(1),
    password: z.string().min(6),
  })
  .partial();

/**
 * Provisionamento de usuários/agentes (RBAC). Apenas a administração central
 * cria e gerencia contas. Senhas são armazenadas apenas como hash (argon2/bcrypt)
 * e nunca retornadas. A associação a operações (escopo multitenant) é feita pelos
 * endpoints de membros em `/operations/:id/members`.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.post('/users', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const body = createUserSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });
    if (body.data.role === Role.AGENTE && !body.data.agentId) {
      return reply.code(400).send({ error: 'agentId é obrigatório para agentes' });
    }

    const passwordHash = await bcrypt.hash(body.data.password, 10);
    try {
      const user = await User.create({
        username: body.data.username,
        name: body.data.name,
        passwordHash,
        role: body.data.role,
        agentId: body.data.agentId,
        operationIds: body.data.operationIds ?? [],
      });
      return reply.code(201).send(serialize(user));
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return reply.code(409).send({ error: 'Nome de usuário já existe' });
      }
      throw err;
    }
  });

  app.get('/users', { onRequest: [app.requireRole(Role.ADMIN)] }, async () => {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    return users.map(serialize);
  });

  app.get('/users/:id', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await User.findById(id).lean();
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
    return serialize(user);
  });

  app.patch('/users/:id', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateUserSchema.safeParse(request.body);
    if (!body.success || Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: 'Dados inválidos' });
    }

    const update: Record<string, unknown> = {};
    if (body.data.name !== undefined) update.name = body.data.name;
    if (body.data.role !== undefined) update.role = body.data.role;
    if (body.data.agentId !== undefined) update.agentId = body.data.agentId;
    if (body.data.password !== undefined) {
      update.passwordHash = await bcrypt.hash(body.data.password, 10);
    }

    const user = await User.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
    return serialize(user);
  });

  app.delete('/users/:id', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await User.findByIdAndDelete(id).lean();
    if (!removed) return reply.code(404).send({ error: 'Usuário não encontrado' });
    return reply.code(204).send();
  });
}

/** Nunca expõe `passwordHash`. */
function serialize(u: {
  _id: unknown;
  username: string;
  name: string;
  role: string;
  agentId?: string | null;
  operationIds?: unknown[];
}) {
  return {
    id: String(u._id),
    username: u.username,
    name: u.name,
    role: u.role,
    agentId: u.agentId ?? undefined,
    operationIds: (u.operationIds ?? []).map(String),
  };
}
