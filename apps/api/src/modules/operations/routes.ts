import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OperationStatus, OperationType, Role, type AuthClaims } from '@cerberus/shared';
import { Operation } from '../../models/index.js';

const createOperationSchema = z.object({
  name: z.string().min(1),
  type: z.enum(Object.values(OperationType) as [string, ...string[]]),
  status: z.enum(Object.values(OperationStatus) as [string, ...string[]]).optional(),
});

/**
 * CRUD de operações (missões). Cada operação é uma fronteira de isolamento
 * multitenant. Listagem e leitura são sempre filtradas pelo escopo do token.
 */
export async function operationRoutes(app: FastifyInstance): Promise<void> {
  // Lista apenas as operações dentro do escopo do usuário.
  app.get('/operations', { onRequest: [app.authenticate] }, async (request) => {
    const claims = request.user as AuthClaims;
    const ops = await Operation.find({ _id: { $in: claims.operationIds } }).sort({ createdAt: -1 });
    return ops.map(serialize);
  });

  app.get('/operations/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const claims = request.user as AuthClaims;
    if (!claims.operationIds.includes(id)) {
      return reply.code(403).send({ error: 'Operação fora do escopo autorizado' });
    }
    const op = await Operation.findById(id);
    if (!op) return reply.code(404).send({ error: 'Operação não encontrada' });
    return serialize(op);
  });

  // Apenas administração central cria operações.
  app.post('/operations', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const body = createOperationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });
    const claims = request.user as AuthClaims;
    const op = await Operation.create({ ...body.data, createdBy: claims.sub });
    return reply.code(201).send(serialize(op));
  });
}

function serialize(op: InstanceType<typeof Operation>) {
  return {
    id: String(op._id),
    name: op.name,
    type: op.type,
    status: op.status,
    createdAt: (op as unknown as { createdAt: Date }).createdAt?.toISOString(),
  };
}
