import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MessageType, Role, operationBroadcastTopic, type AuthClaims } from '@cerberus/shared';
import { MessageModel } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const historyQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(1000).default(100),
  since: z.string().datetime().optional(),
});

const sendMessageSchema = z.object({
  text: z.string().min(1).max(4096),
});

/**
 * Mensagens táticas de texto (MVP). O histórico é escopado por operação; o envio
 * persiste a mensagem e faz broadcast em tempo real aos agentes/dashboard via a
 * ponte MQTT (quando ativa). E2EE (ciphertext) entra na fase dedicada.
 */
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // Histórico de mensagens da operação (escopado).
  app.get('/operations/:id/messages', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;

    const q = historyQuerySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Parâmetros inválidos' });

    const filter: Record<string, unknown> = { operationId: id };
    if (q.data.since) filter.capturedAt = { $gte: new Date(q.data.since) };

    const docs = await MessageModel.find(filter)
      .sort({ capturedAt: -1 })
      .limit(q.data.limit)
      .lean();
    return docs.map(serialize);
  });

  // Envia uma mensagem de texto (escopado) — persiste e faz broadcast aos agentes.
  app.post(
    '/operations/:id/messages',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = sendMessageSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const claims = request.user as AuthClaims;
      const senderId = claims.agentId ?? claims.sub;
      const now = new Date();

      const msg = await MessageModel.create({
        operationId: id,
        senderId,
        type: MessageType.TEXT,
        text: body.data.text,
        capturedAt: now,
        receivedAt: now,
      });

      // Broadcast em tempo real, se a ponte MQTT estiver ativa (desligada em testes).
      if (app.mqtt?.connected) {
        app.mqtt.publish(
          operationBroadcastTopic(id),
          JSON.stringify({
            senderId,
            type: MessageType.TEXT,
            text: body.data.text,
            capturedAt: now.toISOString(),
          }),
          { qos: 1 },
        );
      }

      return reply.code(201).send(serialize(msg));
    },
  );

  // Broadcast da CENTRAL (admin) para todos os agentes da operação. Diferente do
  // chat tático: é uma diretiva de comando. Persiste como mensagem tipo BROADCAST
  // e publica no canal `operacao/{opId}/broadcast`, que os agentes assinam.
  app.post(
    '/operations/:id/broadcast',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = sendMessageSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const claims = request.user as AuthClaims;
      const senderId = claims.agentId ?? claims.sub; // operador que emitiu (auditoria)
      const now = new Date();

      const msg = await MessageModel.create({
        operationId: id,
        senderId,
        type: MessageType.BROADCAST,
        text: body.data.text,
        capturedAt: now,
        receivedAt: now,
      });

      if (app.mqtt?.connected) {
        app.mqtt.publish(
          operationBroadcastTopic(id),
          JSON.stringify({
            senderId,
            type: MessageType.BROADCAST,
            text: body.data.text,
            capturedAt: now.toISOString(),
          }),
          { qos: 1 },
        );
      }

      return reply.code(201).send(serialize(msg));
    },
  );
}

function serialize(m: {
  _id: unknown;
  operationId: string;
  senderId: string;
  type: string;
  text?: string | null;
  mediaRef?: string | null;
  capturedAt?: Date;
}) {
  return {
    id: String(m._id),
    operationId: m.operationId,
    senderId: m.senderId,
    type: m.type,
    text: m.text ?? undefined,
    mediaRef: m.mediaRef ?? undefined,
    capturedAt: m.capturedAt?.toISOString?.() ?? m.capturedAt,
  };
}
