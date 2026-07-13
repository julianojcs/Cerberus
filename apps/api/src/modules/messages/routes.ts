import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MessageType, Role, operationBroadcastTopic, type AuthClaims } from '@cerberus/shared';
import { MessageModel } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const historyQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(1000).default(100),
  since: z.string().datetime().optional(),
});

/**
 * Mensagem E2EE: o corpo carrega apenas o `ciphertext` (envelope base64 cifrado no
 * cliente). O servidor nunca vê o texto em claro. O envelope cresce com o nº de
 * destinatários — daí o limite folgado. Vale para chat de texto e para broadcast.
 */
const encryptedMessageSchema = z.object({
  ciphertext: z.string().min(1).max(500_000),
});

/**
 * Mensagens táticas E2EE. O histórico é escopado por operação; o envio persiste o
 * envelope cifrado e o repassa em tempo real aos agentes/dashboard via a ponte MQTT
 * (quando ativa) no canal `operacao/{opId}/broadcast`. O texto em claro nunca sai
 * do cliente — o servidor só manuseia `ciphertext`.
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

  // Envia uma mensagem de texto E2EE (escopado). O corpo já vem cifrado (envelope
  // por destinatário, montado no cliente pelo diretório de chaves da operação); o
  // servidor persiste/publica só o `ciphertext`. Publica em `operacao/{opId}/broadcast`.
  app.post(
    '/operations/:id/messages',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = encryptedMessageSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const claims = request.user as AuthClaims;
      const senderId = claims.agentId ?? claims.sub;
      const now = new Date();

      const msg = await MessageModel.create({
        operationId: id,
        senderId,
        type: MessageType.TEXT,
        ciphertext: body.data.ciphertext,
        capturedAt: now,
        receivedAt: now,
      });

      // Repasse em tempo real, se a ponte MQTT estiver ativa (desligada em testes).
      if (app.mqtt?.connected) {
        app.mqtt.publish(
          operationBroadcastTopic(id),
          JSON.stringify({
            senderId,
            type: MessageType.TEXT,
            ciphertext: body.data.ciphertext,
            capturedAt: now.toISOString(),
          }),
          { qos: 1 },
        );
      }

      return reply.code(201).send(serialize(msg));
    },
  );

  // Broadcast E2EE da CENTRAL (admin) para todos os agentes da operação. Diferente
  // do chat tático: é uma diretiva de comando. O corpo já vem CIFRADO (envelope
  // por destinatário, montado no dashboard) — o servidor persiste/publica apenas o
  // `ciphertext` e nunca vê o texto. Publica em `operacao/{opId}/broadcast`.
  app.post(
    '/operations/:id/broadcast',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!assertOperationScope(request, reply, id)) return;

      const body = encryptedMessageSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

      const claims = request.user as AuthClaims;
      const senderId = claims.agentId ?? claims.sub; // operador que emitiu (auditoria)
      const now = new Date();

      const msg = await MessageModel.create({
        operationId: id,
        senderId,
        type: MessageType.BROADCAST,
        ciphertext: body.data.ciphertext,
        capturedAt: now,
        receivedAt: now,
      });

      if (app.mqtt?.connected) {
        app.mqtt.publish(
          operationBroadcastTopic(id),
          JSON.stringify({
            senderId,
            type: MessageType.BROADCAST,
            ciphertext: body.data.ciphertext,
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
  ciphertext?: string | null;
  mediaRef?: string | null;
  location?: { coordinates?: number[] } | null;
  capturedAt?: Date;
}) {
  const coords = m.location?.coordinates;
  return {
    id: String(m._id),
    operationId: m.operationId,
    senderId: m.senderId,
    type: m.type,
    text: m.text ?? undefined,
    // Envelope E2EE (broadcast). Sem ele, o histórico cifrado seria indecifrável.
    ciphertext: m.ciphertext ?? undefined,
    mediaRef: m.mediaRef ?? undefined,
    lng: coords?.[0],
    lat: coords?.[1],
    capturedAt: m.capturedAt?.toISOString?.() ?? m.capturedAt,
  };
}
