import type { FastifyReply, FastifyRequest } from 'fastify';
import { Role, type AuthClaims } from '@cerberus/shared';

/**
 * SuperAdmin transcende o RBAC e o escopo multitenant (ADR-0003). Helper único,
 * reusado nas guardas (`assertOperationScope` aqui e `requireRole` no plugin de auth).
 */
export function isSuperAdmin(claims: AuthClaims): boolean {
  return claims.role === Role.SUPERADMIN;
}

/**
 * Isolamento lógico multitenant: garante que o portador do token só acesse
 * dados de operações dentro do seu escopo autorizado (`operation_id`).
 * Retorna `true` se autorizado; caso contrário já responde 403 e retorna `false`.
 */
export function assertOperationScope(
  request: FastifyRequest,
  reply: FastifyReply,
  operationId: string,
): boolean {
  const claims = request.user as AuthClaims;
  // Exceção DELIBERADA à regra mqtt-multitenant.md #4 ("nada sem escopo, mesmo para
  // admin"): o SA é um tier acima do admin e enxerga todas as operações.
  if (isSuperAdmin(claims)) return true;
  if (!claims.operationIds.includes(operationId)) {
    reply.code(403).send({ error: 'Operação fora do escopo autorizado' });
    return false;
  }
  return true;
}
