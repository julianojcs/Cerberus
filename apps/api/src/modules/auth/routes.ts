import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import {
  e2eeKeyBackupSchema,
  loginRequestSchema,
  publicKeyRegistrationSchema,
  Role,
  type AuthClaims,
} from '@cerberus/shared';
import { Session, User } from '../../models/index.js';
import { clientIp, createSession, isDeviceBlocked } from '../sessions/service.js';

/**
 * Rotas de autenticação. O login emite um JWT com o escopo do usuário
 * (papel + operações + agentId), reutilizado depois na conexão MQTT.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'Credenciais malformadas' });
    }

    const user = await User.findOne({ username: body.data.username });
    if (!user) {
      return reply.code(401).send({ error: 'Usuário ou senha inválidos' });
    }

    const ok = await bcrypt.compare(body.data.password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: 'Usuário ou senha inválidos' });
    }

    // Portão de login: conta ou dispositivo bloqueado não recebe sessão.
    if (user.blocked) {
      return reply.code(403).send({ error: 'Conta bloqueada' });
    }
    if (body.data.deviceId && (await isDeviceBlocked(body.data.deviceId))) {
      return reply.code(403).send({ error: 'Dispositivo bloqueado' });
    }

    const sid = await createSession({
      userId: String(user._id),
      deviceId: body.data.deviceId,
      deviceLabel: body.data.deviceLabel,
      platform: body.data.platform,
      ip: clientIp(request),
    });

    const operationIds = (user.operationIds ?? []).map((id) => String(id));
    const claims: AuthClaims = {
      sub: String(user._id),
      role: user.role as Role,
      agentId: user.agentId ?? undefined,
      operationIds,
      sid,
    };

    const token = app.jwt.sign(claims);
    return reply.send({
      token,
      user: {
        id: String(user._id),
        username: user.username,
        name: user.name,
        role: user.role,
        agentId: user.agentId ?? undefined,
        operationIds,
      },
    });
  });

  /** Retorna o perfil do portador do token (útil para o dashboard/app). */
  app.get('/auth/me', { onRequest: [app.authenticate] }, async (request) => {
    return request.user;
  });

  /**
   * Heartbeat de sessão: o app chama periodicamente. Se a sessão foi revogada, o
   * `app.authenticate` já responde 401 (o app então desloga). Atualiza `lastSeenAt`
   * de forma throttled (só se defasado > 20s) para evitar 1 escrita por ping.
   */
  app.get('/auth/session', { onRequest: [app.authenticate] }, async (request) => {
    const claims = request.user as AuthClaims;
    if (claims.sid) {
      await Session.updateOne(
        { _id: claims.sid, lastSeenAt: { $lt: new Date(Date.now() - 20_000) } },
        { $set: { lastSeenAt: new Date() } },
      );
    }
    return { status: 'active' };
  });

  /**
   * Registra/atualiza a chave pública X25519 do portador (E2EE). A chave privada
   * nunca é enviada — fica só no dispositivo (SecureStore) ou navegador. O cliente
   * chama isto no primeiro login/abertura, após gerar o par localmente.
   */
  app.put('/auth/public-key', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = publicKeyRegistrationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Chave pública inválida' });
    const claims = request.user as AuthClaims;
    const newKey = body.data.publicKey;
    const current = await User.findById(claims.sub).select('publicKey').lean();
    if (!current) return reply.code(401).send({ error: 'Usuário não encontrado' });
    // Fase 5e-2 — rotação: se a chave mudou, arquiva a antiga no histórico (sem
    // duplicar) e limpa a revogação. Re-registrar a MESMA chave é idempotente.
    const changed = current.publicKey && current.publicKey !== newKey;
    const user = await User.findByIdAndUpdate(
      claims.sub,
      {
        $set: { publicKey: newKey, keyRevoked: false },
        ...(changed ? { $addToSet: { publicKeyHistory: current.publicKey } } : {}),
      },
      { new: true },
    );
    return reply.send({ publicKey: user?.publicKey });
  });

  /**
   * Backup da chave E2EE cifrado NO CLIENTE (Fase 5e-3). O cliente sobe o BLOB já
   * cifrado pela passphrase (AES-GCM); o servidor guarda opaco — nunca vê a chave nem
   * a senha. Escopo estrito ao próprio portador (`claims.sub`): não há acesso cruzado.
   */
  app.put('/auth/e2ee-backup', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = e2eeKeyBackupSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Backup de chave inválido' });
    const claims = request.user as AuthClaims;
    await User.updateOne(
      { _id: claims.sub },
      { $set: { e2eeBackup: { ...body.data, updatedAt: new Date() } } },
    );
    return reply.code(204).send();
  });

  app.get('/auth/e2ee-backup', { onRequest: [app.authenticate] }, async (request, reply) => {
    const claims = request.user as AuthClaims;
    const u = await User.findById(claims.sub).select('e2eeBackup').lean();
    const b = u?.e2eeBackup;
    if (!b?.ct) return reply.code(404).send({ error: 'Sem backup de chave na nuvem' });
    return reply.send({ v: b.v, salt: b.salt, iv: b.iv, ct: b.ct });
  });

  app.delete('/auth/e2ee-backup', { onRequest: [app.authenticate] }, async (request, reply) => {
    const claims = request.user as AuthClaims;
    await User.updateOne({ _id: claims.sub }, { $unset: { e2eeBackup: 1 } });
    return reply.code(204).send();
  });

  /**
   * Re-emite o JWT com o escopo atual do usuário no banco. Necessário quando o
   * escopo muda em sessão (ex.: admin cria/entra numa operação) — o token antigo
   * é um snapshot do login e não reflete a mudança até um refresh.
   */
  app.post('/auth/refresh', { onRequest: [app.authenticate] }, async (request, reply) => {
    const current = request.user as AuthClaims;
    const user = await User.findById(current.sub);
    if (!user) return reply.code(401).send({ error: 'Usuário não encontrado' });
    if (user.blocked) return reply.code(401).send({ error: 'Conta bloqueada' });

    // Reusa o sid atual; token legado (sem sid) ganha uma sessão (vira revogável).
    const sid =
      current.sid ?? (await createSession({ userId: String(user._id), ip: clientIp(request) }));

    const operationIds = (user.operationIds ?? []).map((id) => String(id));
    const claims: AuthClaims = {
      sub: String(user._id),
      role: user.role as Role,
      agentId: user.agentId ?? undefined,
      operationIds,
      sid,
    };

    const token = app.jwt.sign(claims);
    return reply.send({
      token,
      user: {
        id: String(user._id),
        username: user.username,
        name: user.name,
        role: user.role,
        agentId: user.agentId ?? undefined,
        operationIds,
      },
    });
  });
}
