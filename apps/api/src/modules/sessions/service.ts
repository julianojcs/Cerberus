import type { FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { SessionRevokeReason } from '@cerberus/shared';
import { AuditLog, DeviceBlock, Session } from '../../models/index.js';

/** IP do cliente para auditoria (socket; atrás de proxy usa x-forwarded-for). */
export function clientIp(request: FastifyRequest): string | undefined {
  const fwd = request.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim();
  return request.ip;
}

/** Cria uma sessão (login de dispositivo) e devolve o `sid`. */
export async function createSession(input: {
  userId: string;
  deviceId?: string;
  deviceLabel?: string;
  platform?: string;
  ip?: string;
}): Promise<string> {
  const session = await Session.create({
    userId: input.userId,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    platform: input.platform,
    ip: input.ip,
    lastSeenAt: new Date(),
  });
  return String(session._id);
}

/** Uma sessão está ativa se existe e não foi revogada. `sid` inválido = inativa. */
export async function isSessionActive(sid: string): Promise<{ active: boolean; reason?: string }> {
  if (!Types.ObjectId.isValid(sid)) {
    return { active: false, reason: SessionRevokeReason.SESSION_REVOKED };
  }
  const s = await Session.findById(sid).select('revokedAt revokedReason').lean();
  if (!s || s.revokedAt) {
    return { active: false, reason: s?.revokedReason ?? SessionRevokeReason.SESSION_REVOKED };
  }
  return { active: true };
}

export async function revokeSession(sid: string, reason: string): Promise<boolean> {
  const res = await Session.updateOne(
    { _id: sid, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount > 0;
}

export async function revokeUserSessions(userId: string, reason: string): Promise<number> {
  const res = await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

export async function revokeDeviceSessions(deviceId: string, reason: string): Promise<number> {
  const res = await Session.updateMany(
    { deviceId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
}

/** Um dispositivo está na denylist permanente? */
export async function isDeviceBlocked(deviceId: string): Promise<boolean> {
  return (await DeviceBlock.exists({ deviceId })) != null;
}

/** Registra uma ação sensível na trilha de auditoria. */
export async function writeAudit(entry: {
  actorId: string;
  action: string;
  targetUserId?: string;
  targetDeviceId?: string;
  targetSid?: string;
  reason?: string;
  ip?: string;
}): Promise<void> {
  await AuditLog.create(entry);
}
