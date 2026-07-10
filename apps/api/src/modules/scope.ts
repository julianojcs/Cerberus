import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthClaims } from '@cerberus/shared';

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
  if (!claims.operationIds.includes(operationId)) {
    reply.code(403).send({ error: 'Operação fora do escopo autorizado' });
    return false;
  }
  return true;
}
