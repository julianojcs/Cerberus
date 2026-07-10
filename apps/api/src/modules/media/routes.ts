import type { FastifyInstance } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { Types } from 'mongoose';
import { MessageType, operationBroadcastTopic, type AuthClaims } from '@cerberus/shared';
import { MessageModel } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const BUCKET = 'media';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Captura/upload de mídia tática (fotos) do agente. O binário é persistido em
 * GridFS (coleção `media.*`) com metadata escopada por `operationId`; uma mensagem
 * tipo MEDIA referencia o arquivo (`mediaRef`) e é anunciada no canal broadcast.
 * O download é escopado: só quem está na operação lê a mídia dela.
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  function bucket() {
    const db = app.mongoose.connection.db;
    if (!db) throw new Error('MongoDB indisponível');
    return new app.mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
  }

  // Upload de mídia do agente → GridFS + mensagem MEDIA.
  app.post('/operations/:id/media', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Arquivo ausente' });
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      file.file.resume(); // drena o stream para não pendurar a requisição
      return reply.code(415).send({ error: 'Tipo de mídia não suportado' });
    }

    const claims = request.user as AuthClaims;
    const senderId = claims.agentId ?? claims.sub;
    const now = new Date();

    const upload = bucket().openUploadStream(file.filename || 'media', {
      contentType: file.mimetype,
      metadata: { operationId: id, senderId },
    });
    try {
      await pipeline(file.file, upload);
    } catch {
      await bucket()
        .delete(upload.id)
        .catch(() => {});
      return reply.code(500).send({ error: 'Falha ao armazenar a mídia' });
    }
    // O multipart marca `truncated` se o arquivo estourou o limite de tamanho.
    if (file.file.truncated) {
      await bucket()
        .delete(upload.id)
        .catch(() => {});
      return reply.code(413).send({ error: 'Mídia excede o tamanho máximo (8 MB)' });
    }

    const mediaRef = String(upload.id);
    const msg = await MessageModel.create({
      operationId: id,
      senderId,
      type: MessageType.MEDIA,
      mediaRef,
      capturedAt: now,
      receivedAt: now,
    });

    if (app.mqtt?.connected) {
      app.mqtt.publish(
        operationBroadcastTopic(id),
        JSON.stringify({
          senderId,
          type: MessageType.MEDIA,
          mediaRef,
          capturedAt: now.toISOString(),
        }),
        { qos: 1 },
      );
    }

    return reply.code(201).send({
      id: String(msg._id),
      operationId: id,
      senderId,
      type: MessageType.MEDIA,
      mediaRef,
      capturedAt: now.toISOString(),
    });
  });

  // Download/stream da mídia — escopado: a mídia deve pertencer à operação do token.
  app.get(
    '/operations/:id/media/:fileId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, fileId } = request.params as { id: string; fileId: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(fileId)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }

      const _id = new Types.ObjectId(fileId);
      const files = await bucket().find({ _id }).toArray();
      const f = files[0];
      if (!f || (f.metadata as { operationId?: string } | undefined)?.operationId !== id) {
        return reply.code(404).send({ error: 'Mídia não encontrada' });
      }

      reply.header('Content-Type', f.contentType ?? 'application/octet-stream');
      reply.header('Content-Length', String(f.length));
      return reply.send(bucket().openDownloadStream(_id));
    },
  );
}
