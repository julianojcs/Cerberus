import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { loginRequestSchema, Role, type AuthClaims } from '@cerberus/shared';
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
}
