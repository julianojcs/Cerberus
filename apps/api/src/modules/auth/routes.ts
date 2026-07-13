import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import {
  loginRequestSchema,
  publicKeyRegistrationSchema,
  Role,
  type AuthClaims,
} from '@cerberus/shared';
import { User } from '../../models/index.js';

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

    const operationIds = (user.operationIds ?? []).map((id) => String(id));
    const claims: AuthClaims = {
      sub: String(user._id),
      role: user.role as Role,
      agentId: user.agentId ?? undefined,
      operationIds,
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
   * Registra/atualiza a chave pública X25519 do portador (E2EE). A chave privada
   * nunca é enviada — fica só no dispositivo (SecureStore) ou navegador. O cliente
   * chama isto no primeiro login/abertura, após gerar o par localmente.
   */
  app.put('/auth/public-key', { onRequest: [app.authenticate] }, async (request, reply) => {
    const body = publicKeyRegistrationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Chave pública inválida' });
    const claims = request.user as AuthClaims;
    const user = await User.findByIdAndUpdate(
      claims.sub,
      { $set: { publicKey: body.data.publicKey } },
      { new: true },
    );
    if (!user) return reply.code(401).send({ error: 'Usuário não encontrado' });
    return reply.send({ publicKey: user.publicKey });
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

    const operationIds = (user.operationIds ?? []).map((id) => String(id));
    const claims: AuthClaims = {
      sub: String(user._id),
      role: user.role as Role,
      agentId: user.agentId ?? undefined,
      operationIds,
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
