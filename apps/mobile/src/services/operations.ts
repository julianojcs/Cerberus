import { authedFetch } from './http';

/**
 * Nome da operação para exibir no cabeçalho (em vez do id cru). O agente tem a
 * operação no escopo do token, então `GET /operations/:id` é permitido. Falha de
 * rede/escopo → `null` (o cabeçalho cai no id como fallback).
 */
export async function fetchOperationName(
  session: { token: string },
  operationId: string,
): Promise<string | null> {
  try {
    const res = await authedFetch(session.token, `/operations/${operationId}`);
    if (!res.ok) return null;
    const op = (await res.json()) as { name?: string };
    return typeof op.name === 'string' && op.name.length > 0 ? op.name : null;
  } catch {
    return null;
  }
}
