import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { Types } from 'mongoose';
import {
  MessageType,
  Role,
  agentInboxTopic,
  operationBroadcastTopic,
  teamBroadcastTopic,
  type AuthClaims,
} from '@cerberus/shared';
import { MessageModel, Team } from '../../models/index.js';
import { assertOperationScope } from '../scope.js';

const BUCKET = 'media';

/**
 * Captura/upload de mídia tática (fotos) — **E2EE**. O cliente cifra a imagem
 * (secretbox) e envia o binário **opaco**; a legenda, o geotag e a chave da imagem
 * viajam num envelope por destinatário (`ciphertext`). O servidor persiste o blob
 * cifrado em GridFS (metadata escopada por `operationId`) e o envelope na mensagem
 * tipo MEDIA — nunca vê a imagem nem a legenda. A mídia pode ser da operação inteira
 * (agente→central) ou escopada a uma EQUIPE / DM (Fase 3b): mesmo blob, o envelope é
 * selado só para o subconjunto e a publicação vai no tópico certo. O download é
 * escopado por operação: só quem está nela (e tem a chave) lê/decifra.
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  function bucket() {
    const db = app.mongoose.connection.db;
    if (!db) throw new Error('MongoDB indisponível');
    return new app.mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
  }

  /**
   * Fluxo comum: lê o envelope (`ciphertext`) + o blob do multipart, grava no GridFS,
   * cria a mensagem MEDIA (com `teamId`/`recipientId` quando escopada) e publica no
   * tópico. `topic` decide o alcance (operação / equipe / inbox do agente).
   */
  async function handleMediaUpload(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: {
      operationId: string;
      senderId: string;
      topic: string;
      teamId?: string;
      recipientId?: string;
    },
  ): Promise<void> {
    const file = await request.file();
    if (!file) {
      reply.code(400).send({ error: 'Arquivo ausente' });
      return;
    }
    // Envelope E2EE (legenda + geotag + chave da imagem), cifrado no cliente. Vem
    // ANTES do arquivo no form para estar disponível em `file.fields`.
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const ciphertext = typeof fields.ciphertext?.value === 'string' ? fields.ciphertext.value : '';
    if (!ciphertext || ciphertext.length > 500_000) {
      file.file.resume(); // drena o stream para não pendurar a requisição
      reply.code(400).send({ error: 'Envelope da mídia ausente ou inválido' });
      return;
    }

    const now = new Date();
    // O blob é opaco (cifrado): tipo genérico, sem inspeção de conteúdo.
    const upload = bucket().openUploadStream(file.filename || 'media', {
      contentType: 'application/octet-stream',
      metadata: { operationId: ctx.operationId, senderId: ctx.senderId },
    });
    try {
      await pipeline(file.file, upload);
    } catch {
      await bucket()
        .delete(upload.id)
        .catch(() => {});
      reply.code(500).send({ error: 'Falha ao armazenar a mídia' });
      return;
    }
    if (file.file.truncated) {
      await bucket()
        .delete(upload.id)
        .catch(() => {});
      reply.code(413).send({ error: 'Mídia excede o tamanho máximo (8 MB)' });
      return;
    }

    const mediaRef = String(upload.id);
    const msg = await MessageModel.create({
      operationId: ctx.operationId,
      senderId: ctx.senderId,
      type: MessageType.MEDIA,
      mediaRef,
      ciphertext,
      teamId: ctx.teamId,
      recipientId: ctx.recipientId,
      capturedAt: now,
      receivedAt: now,
    });

    if (app.mqtt?.connected) {
      app.mqtt.publish(
        ctx.topic,
        JSON.stringify({
          senderId: ctx.senderId,
          type: MessageType.MEDIA,
          mediaRef,
          ciphertext,
          teamId: ctx.teamId,
          recipientId: ctx.recipientId,
          capturedAt: now.toISOString(),
        }),
        { qos: 1 },
      );
    }

    reply.code(201).send({
      id: String(msg._id),
      operationId: ctx.operationId,
      senderId: ctx.senderId,
      type: MessageType.MEDIA,
      mediaRef,
      ciphertext,
      teamId: ctx.teamId,
      recipientId: ctx.recipientId,
      capturedAt: now.toISOString(),
    });
  }

  // Upload de mídia para a operação inteira (agente→central).
  app.post('/operations/:id/media', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!assertOperationScope(request, reply, id)) return;
    const claims = request.user as AuthClaims;
    await handleMediaUpload(request, reply, {
      operationId: id,
      senderId: claims.agentId ?? claims.sub,
      topic: operationBroadcastTopic(id),
    });
  });

  // Mídia para uma EQUIPE (membro ou central). Selada só para os membros (no cliente).
  app.post(
    '/operations/:id/teams/:tid/media',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id, tid } = request.params as { id: string; tid: string };
      if (!assertOperationScope(request, reply, id)) return;
      if (!Types.ObjectId.isValid(tid)) {
        return reply.code(400).send({ error: 'Identificador inválido' });
      }
      const claims = request.user as AuthClaims;
      const team = await Team.findOne({ _id: tid, operationId: id }).lean();
      if (!team) return reply.code(404).send({ error: 'Equipe não encontrada' });
      // Agente só posta na PRÓPRIA equipe; admin/SA em qualquer equipe da operação.
      if (
        claims.role === Role.AGENTE &&
        !(claims.agentId && (team.agentIds ?? []).includes(claims.agentId))
      ) {
        return reply.code(403).send({ error: 'Acesso negado ao recurso' });
      }
      await handleMediaUpload(request, reply, {
        operationId: id,
        senderId: claims.agentId ?? claims.sub,
        teamId: tid,
        topic: teamBroadcastTopic(id, tid),
      });
    },
  );

  // DM de mídia da central (admin) → um agente. Selada só para o agente (no cliente).
  app.post(
    '/operations/:id/agents/:agentId/media',
    { onRequest: [app.requireRole(Role.ADMIN)] },
    async (request, reply) => {
      const { id, agentId } = request.params as { id: string; agentId: string };
      if (!assertOperationScope(request, reply, id)) return;
      const claims = request.user as AuthClaims;
      await handleMediaUpload(request, reply, {
        operationId: id,
        senderId: claims.agentId ?? claims.sub,
        recipientId: agentId,
        topic: agentInboxTopic(id, agentId),
      });
    },
  );

  // Download/stream da mídia — escopado: a mídia deve pertencer à operação do token.
  // (O envelope E2EE restringe quem decifra; o transporte só checa a operação.)
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
