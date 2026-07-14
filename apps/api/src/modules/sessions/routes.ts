import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Role, SessionRevokeReason, type AuthClaims } from '@cerberus/shared';
import { AuditLog, DeviceBlock, Session, User } from '../../models/index.js';
import {
  clientIp,
  revokeDeviceSessions,
  revokeSession,
  revokeUserSessions,
  writeAudit,
} from './service.js';

/**
 * Gestão de dispositivos/sessões (SUPERADMIN). Kick = revogar uma sessão; block de
 * conta/dispositivo = denylist (barra o login) + revoga as sessões. A denylist é
 * gravada ANTES da revogação para fechar a janela de re-login durante o bloqueio.
 * Toda ação mutante registra auditoria.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const SA = { onRequest: [app.requireRole(Role.SUPERADMIN)] };

  // Lista as sessões (dispositivos) de um usuário.
  app.get('/users/:id/devices', SA, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.code(400).send({ error: 'Identificador inválido' });
    const sessions = await Session.find({ userId: id }).sort({ createdAt: -1 }).lean();
    return sessions.map(serializeSession);
  });

  // Derruba (revoga) uma sessão específica. O usuário pode relogar (kick ≠ block).
  app.post('/sessions/:sid/kick', SA, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { sid } = request.params as { sid: string };
    if (!Types.ObjectId.isValid(sid)) return reply.code(400).send({ error: 'Identificador inválido' });
    const ok = await revokeSession(sid, SessionRevokeReason.KICKED);
    if (!ok) return reply.code(404).send({ error: 'Sessão não encontrada ou já revogada' });
    await writeAudit({ actorId: claims.sub, action: 'session.kick', targetSid: sid, ip: clientIp(request) });
    return reply.code(204).send();
  });

  // Bloqueia uma conta: denylist (barra login) + revoga todas as sessões.
  app.post('/users/:id/block', SA, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.code(400).send({ error: 'Identificador inválido' });
    if (id === claims.sub) return reply.code(403).send({ error: 'Não é possível bloquear a si mesmo' });
    const target = await User.findById(id).lean();
    if (!target) return reply.code(404).send({ error: 'Usuário não encontrado' });
    if (target.role === Role.SUPERADMIN) {
      const saCount = await User.countDocuments({ role: Role.SUPERADMIN });
      if (saCount <= 1) {
        return reply.code(409).send({ error: 'Não é possível bloquear o último superadmin' });
      }
    }
    await User.updateOne({ _id: id }, { $set: { blocked: true } }); // denylist ANTES
    await revokeUserSessions(id, SessionRevokeReason.ACCOUNT_BLOCKED);
    await writeAudit({ actorId: claims.sub, action: 'user.block', targetUserId: id, ip: clientIp(request) });
    return reply.code(204).send();
  });

  app.post('/users/:id/unblock', SA, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.code(400).send({ error: 'Identificador inválido' });
    const res = await User.updateOne({ _id: id }, { $set: { blocked: false } });
    if (res.matchedCount === 0) return reply.code(404).send({ error: 'Usuário não encontrado' });
    await writeAudit({ actorId: claims.sub, action: 'user.unblock', targetUserId: id, ip: clientIp(request) });
    return reply.code(204).send();
  });

  // Bloqueia um dispositivo permanentemente: denylist + revoga as sessões do device.
  app.post('/devices/:deviceId/block', SA, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { deviceId } = request.params as { deviceId: string };
    const raw = (request.body ?? {}) as { reason?: unknown };
    const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
    try {
      await DeviceBlock.create({ deviceId, blockedBy: claims.sub, reason }); // denylist ANTES
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // 11000 = já bloqueado (idempotente)
    }
    await revokeDeviceSessions(deviceId, SessionRevokeReason.DEVICE_BLOCKED);
    await writeAudit({
      actorId: claims.sub,
      action: 'device.block',
      targetDeviceId: deviceId,
      reason,
      ip: clientIp(request),
    });
    return reply.code(204).send();
  });

  app.post('/devices/:deviceId/unblock', SA, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const { deviceId } = request.params as { deviceId: string };
    const res = await DeviceBlock.deleteOne({ deviceId });
    if (res.deletedCount === 0) return reply.code(404).send({ error: 'Dispositivo não está bloqueado' });
    await writeAudit({ actorId: claims.sub, action: 'device.unblock', targetDeviceId: deviceId, ip: clientIp(request) });
    return reply.code(204).send();
  });

  app.get('/devices/blocked', SA, async () => {
    const blocks = await DeviceBlock.find().sort({ createdAt: -1 }).lean();
    return blocks.map(serializeDeviceBlock);
  });

  // Trilha de auditoria (mais recentes primeiro).
  app.get('/audit', SA, async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(Number(q.limit) || 200, 500);
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
    return logs.map(serializeAudit);
  });
}

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : undefined);

function serializeSession(s: Record<string, unknown>) {
  return {
    id: String(s._id),
    userId: String(s.userId),
    deviceId: (s.deviceId as string | undefined) ?? undefined,
    deviceLabel: (s.deviceLabel as string | undefined) ?? undefined,
    platform: (s.platform as string | undefined) ?? undefined,
    ip: (s.ip as string | undefined) ?? undefined,
    createdAt: iso(s.createdAt),
    lastSeenAt: iso(s.lastSeenAt),
    revokedAt: iso(s.revokedAt),
    revokedReason: (s.revokedReason as string | undefined) ?? undefined,
  };
}

function serializeDeviceBlock(b: Record<string, unknown>) {
  return {
    deviceId: String(b.deviceId),
    blockedBy: String(b.blockedBy),
    reason: (b.reason as string | undefined) ?? undefined,
    createdAt: iso(b.createdAt),
  };
}

function serializeAudit(a: Record<string, unknown>) {
  return {
    id: String(a._id),
    actorId: String(a.actorId),
    action: String(a.action),
    targetUserId: a.targetUserId ? String(a.targetUserId) : undefined,
    targetDeviceId: (a.targetDeviceId as string | undefined) ?? undefined,
    targetSid: (a.targetSid as string | undefined) ?? undefined,
    reason: (a.reason as string | undefined) ?? undefined,
    ip: (a.ip as string | undefined) ?? undefined,
    createdAt: iso(a.createdAt),
  };
}
