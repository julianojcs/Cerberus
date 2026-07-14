import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  OperationStatus,
  OperationType,
  Role,
  type AuthClaims,
  type KeyDirectoryEntry,
} from '@cerberus/shared';
import { Types } from 'mongoose';
import {
  Alert,
  Geofence,
  GeofenceMembership,
  MessageModel,
  Operation,
  Position,
  User,
} from '../../models/index.js';
import { assertOperationScope, isSuperAdmin } from '../scope.js';

const operationTypes = Object.values(OperationType) as [string, ...string[]];
const operationStatuses = Object.values(OperationStatus) as [string, ...string[]];

const createOperationSchema = z.object({
  name: z.string().min(1),
  type: z.enum(operationTypes),
  status: z.enum(operationStatuses).optional(),
});

/** Atualização parcial — pelo menos um campo deve ser enviado. */
const updateOperationSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(operationTypes),
    status: z.enum(operationStatuses),
  })
  .partial();

const memberSchema = z.object({ userId: z.string().min(1) });

/**
 * CRUD de operações (missões). Cada operação é uma fronteira de isolamento
 * multitenant. Listagem e leitura são sempre filtradas pelo escopo do token;
 * escrita e gestão de membros exigem papel de administração central.
 */
export async function operationRoutes(app: FastifyInstance): Promise<void> {
  // Lista as operações dentro do escopo do usuário (SA enxerga todas).
  app.get('/operations', { onRequest: [app.authenticate] }, async (request) => {
    const claims = request.user as AuthClaims;
    const filter = isSuperAdmin(claims) ? {} : { _id: { $in: claims.operationIds } };
    const ops = await Operation.find(filter).sort({ createdAt: -1 });
    return ops.map(serialize);
  });

  app.get('/operations/:id', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
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
    // O criador entra no escopo da operação — senão não conseguiria gerenciá-la
    // nem atribuir membros. O token atual continua com o escopo antigo até um
    // /auth/refresh (ou novo login).
    await User.findByIdAndUpdate(claims.sub, { $addToSet: { operationIds: op._id } });
    return reply.code(201).send(serialize(op));
  });

  // Atualiza uma operação (admin + escopo).
  app.patch(
    '/operations/:id',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;
      const body = updateOperationSchema.safeParse(request.body);
      if (!body.success || Object.keys(body.data).length === 0) {
        return reply.code(400).send({ error: 'Dados inválidos' });
      }
      const op = await Operation.findByIdAndUpdate(id, { $set: body.data }, { new: true });
      if (!op) return reply.code(404).send({ error: 'Operação não encontrada' });
      return serialize(op);
    },
  );

  // Lista os usuários no escopo da operação (admin + escopo).
  app.get(
    '/operations/:id/members',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;
      const users = await User.find({ operationIds: id }).lean();
      return users.map(serializeMember);
    },
  );

  // Atribui um usuário à operação — adiciona a operação ao escopo do usuário.
  app.post(
    '/operations/:id/members',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;
      const body = memberSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });
      const user = await User.findByIdAndUpdate(
        body.data.userId,
        { $addToSet: { operationIds: id } },
        { new: true },
      );
      if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
      return reply.code(201).send(serializeMember(user));
    },
  );

  // Diretório de chaves públicas da operação (autenticado + escopo). Alimenta o
  // envelope E2EE: a central cifra a `publicKey` de cada agente. Só entram membros
  // que já registraram sua chave; quem não registrou não recebe (nem decifra).
  app.get('/operations/:id/keys', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
    const users = await User.find({ operationIds: id, publicKey: { $ne: null } }).lean();
    return users
      .filter((u) => typeof u.publicKey === 'string' && u.publicKey.length > 0)
      .map(serializeKey);
  });

  // Remove um usuário do escopo da operação (admin + escopo).
  app.delete(
    '/operations/:id/members/:userId',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      if (!assertOperationScope(request, reply, id)) return;
      const user = await User.findByIdAndUpdate(
        userId,
        { $pull: { operationIds: id } },
        { new: true },
      );
      if (!user) return reply.code(404).send({ error: 'Usuário não encontrado' });
      return reply.code(204).send();
    },
  );

  // Exclusão definitiva de uma operação — SUPERADMIN apenas (alto blast-radius).
  // Cascata: apaga toda a telemetria/zonas/mídia da operação e remove a operação do
  // escopo dos membros. Sem transação multi-doc (Mongo standalone) — best-effort, com
  // o doc da operação apagado POR ÚLTIMO (falha no meio deixa a op ainda retentável).
  app.delete(
    '/operations/:id',
    { onRequest: [app.requireRole(Role.SUPERADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!Types.ObjectId.isValid(id)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const op = await Operation.findById(id);
      if (!op) return reply.code(404).send({ error: 'Operação não encontrada' });

      const [positions, messages, geofences, alerts, memberships] = await Promise.all([
        Position.deleteMany({ operationId: id }),
        MessageModel.deleteMany({ operationId: id }),
        Geofence.deleteMany({ operationId: id }),
        Alert.deleteMany({ operationId: id }),
        GeofenceMembership.deleteMany({ operationId: id }),
      ]);

      // Blobs de mídia E2EE no GridFS ficam órfãos após apagar as mensagens.
      let mediaDeleted = 0;
      const db = app.mongoose.connection.db;
      if (db) {
        const bucket = new app.mongoose.mongo.GridFSBucket(db, { bucketName: 'media' });
        const files = await bucket.find({ 'metadata.operationId': id }).toArray();
        for (const f of files) {
          await bucket.delete(f._id).catch(() => {});
          mediaDeleted += 1;
        }
      }

      // Usuários são globais: só remove a operação do escopo (não apaga contas).
      const unscoped = await User.updateMany(
        { operationIds: id },
        { $pull: { operationIds: id } },
      );

      // Doc da operação por ÚLTIMO (idempotência sob falha parcial).
      await Operation.findByIdAndDelete(id);

      request.log.info(
        {
          operationId: id,
          positions: positions.deletedCount,
          messages: messages.deletedCount,
          geofences: geofences.deletedCount,
          alerts: alerts.deletedCount,
          memberships: memberships.deletedCount,
          mediaDeleted,
          membersUnscoped: unscoped.modifiedCount,
        },
        'Operação excluída (cascata)',
      );
      return reply.code(204).send();
    },
  );
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

function serializeMember(u: {
  _id: unknown;
  username: string;
  name: string;
  role: string;
  agentId?: string | null;
}) {
  return {
    id: String(u._id),
    username: u.username,
    name: u.name,
    role: u.role,
    agentId: u.agentId ?? undefined,
  };
}

/** Entrada do diretório de chaves. `id` = identificador de destinatário no envelope. */
function serializeKey(u: {
  _id: unknown;
  role: string;
  agentId?: string | null;
  publicKey?: string | null;
}): KeyDirectoryEntry {
  const userId = String(u._id);
  return {
    id: u.agentId ?? userId,
    userId,
    role: u.role as Role,
    agentId: u.agentId ?? undefined,
    publicKey: u.publicKey as string,
  };
}
