import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthClaims, Role } from '@cerberus/shared';
import { isSuperAdmin } from '../modules/scope.js';
import { isSessionActive } from '../modules/sessions/service.js';

/**
 * 401 se o token traz um `sid` cuja sessão foi revogada/removida; `null` se ativa
 * ou se o token não tem `sid` (legado → fail-open, expira em ≤8h). O corpo carrega o
 * `reason` (kicked/account_blocked/device_blocked) para o cliente decidir a UX.
 */
async function sessionRevoked(
  request: FastifyRequest,
): Promise<{ error: string; reason: string } | null> {
  const claims = request.user as AuthClaims;
  if (!claims.sid) return null;
  const { active, reason } = await isSessionActive(claims.sid);
  if (active) return null;
  return { error: 'Sessão revogada', reason: reason ?? 'session_revoked' };
}

/**
 * Autenticação JWT. O mesmo token emitido no login é reutilizado como
 * credencial de conexão no broker MQTT (base para as ACLs de tópico).
 */
export default fp(async function authPlugin(app: FastifyInstance) {
  app.register(fastifyJwt, {
    secret: app.env.JWT_SECRET,
    sign: { expiresIn: app.env.JWT_EXPIRES_IN },
  });

  /** Exige um token válido; popula `request.user` com os claims. */
  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Não autenticado' });
    }
    const revoked = await sessionRevoked(request);
    if (revoked) return reply.code(401).send(revoked);
  });

  /** Exige um dos papéis informados. */
  app.decorate('requireRole', function (...roles: Role[]) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'Não autenticado' });
      }
      const revoked = await sessionRevoked(request);
      if (revoked) return reply.code(401).send(revoked);
      const claims = request.user as AuthClaims;
      // SA transcende o RBAC: passa em qualquer requireRole. Como consequência,
      // requireRole(Role.SUPERADMIN) vira SA-only (admin cai no allow-list → 403).
      if (isSuperAdmin(claims)) return;
      if (!roles.includes(claims.role as Role)) {
        return reply.code(403).send({ error: 'Acesso negado ao recurso' });
      }
    };
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: Role[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthClaims;
    user: AuthClaims;
  }
}
