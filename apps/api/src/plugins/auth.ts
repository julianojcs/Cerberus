import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthClaims, Role } from '@cerberus/shared';

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
  });

  /** Exige um dos papéis informados. */
  app.decorate('requireRole', function (...roles: Role[]) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'Não autenticado' });
      }
      const claims = request.user as AuthClaims;
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
