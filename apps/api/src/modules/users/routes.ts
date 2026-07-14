import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Role, type AuthClaims } from '@cerberus/shared';
import { User } from '../../models/index.js';
import { isSuperAdmin } from '../scope.js';

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
 * Provisionamento de usuários (RBAC hierárquico). Admin gerencia apenas Agentes de
 * Campo; SuperAdmin gerencia qualquer papel. Senhas só como hash, nunca retornadas.
 * A associação a operações (escopo) é feita em `/operations/:id/members`.
 *
 * Visibilidade: o Admin só enxerga/age sobre `agente` — alvos de outro papel respondem
 * 404 (anti-enumeração). Exceção: o próprio registro é sempre visível/editável
 * (name/password), evitando lockout do próprio operador.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.post('/users', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const body = createUserSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });
    // Admin só cria agentes; criar admin/superadmin é escalada de privilégio.
    if (!isSuperAdmin(claims) && body.data.role !== Role.AGENTE) {
      return reply.code(403).send({ error: 'Acesso negado ao recurso' });
    }
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

  app.get('/users', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request) => {
    const claims = request.user as AuthClaims;
    // SA vê todos; admin só os agentes.
    const filter = isSuperAdmin(claims) ? {} : { role: Role.AGENTE };
    const users = await User.find(filter).sort({ createdAt: -1 }).lean();
    return users.map(serialize);
  });

  app.get('/users/:id', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { id } = request.params as { id: string };
    const user = await User.findById(id).lean();
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
    // Admin só enxerga agentes (o próprio registro é exceção).
    if (!isSuperAdmin(claims) && id !== claims.sub && user.role !== Role.AGENTE) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }
    return serialize(user);
  });

  app.patch('/users/:id', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { id } = request.params as { id: string };
    const body = updateUserSchema.safeParse(request.body);
    if (!body.success || Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: 'Dados inválidos' });
    }

    const target = await User.findById(id).lean();
    if (!target) return reply.code(404).send({ error: 'Usuário não encontrado' });

    const actorIsSA = isSuperAdmin(claims);
    const isSelf = id === claims.sub;
    // Visibilidade: admin só age sobre agentes (o próprio registro é exceção).
    if (!actorIsSA && !isSelf && target.role !== Role.AGENTE) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }

    // Mudança de papel: admin nunca muda papéis; SA não pode zerar os superadmins.
    if (body.data.role !== undefined && body.data.role !== target.role) {
      if (!actorIsSA) {
        return reply.code(403).send({ error: 'Acesso negado ao recurso' });
      }
      if (target.role === Role.SUPERADMIN) {
        const saCount = await User.countDocuments({ role: Role.SUPERADMIN });
        if (saCount <= 1) {
          return reply.code(409).send({ error: 'Não é possível rebaixar o último superadmin' });
        }
      }
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
    const claims = request.user as AuthClaims;
    const { id } = request.params as { id: string };
    // Autoexclusão bloqueada (evita lockout) — checada primeiro.
    if (id === claims.sub) {
      return reply.code(403).send({ error: 'Não é possível excluir a si mesmo' });
    }

    const target = await User.findById(id).lean();
    if (!target) return reply.code(404).send({ error: 'Usuário não encontrado' });
    // Admin só enxerga agentes.
    if (!isSuperAdmin(claims) && target.role !== Role.AGENTE) {
      return reply.code(404).send({ error: 'Usuário não encontrado' });
    }
    // Invariante: nunca zerar os superadmins (reforço além do self-guard).
    if (target.role === Role.SUPERADMIN) {
      const saCount = await User.countDocuments({ role: Role.SUPERADMIN });
      if (saCount <= 1) {
        return reply.code(409).send({ error: 'Não é possível excluir o último superadmin' });
      }
    }

    await User.findByIdAndDelete(id);
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
