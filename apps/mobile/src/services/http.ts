import { config } from '../config';

type UnauthorizedHandler = (reason?: string) => void;
let handler: UnauthorizedHandler | null = null;

/** Registra o callback global de sessão inválida (o App faz o logout forçado). */
export function setUnauthorizedHandler(cb: UnauthorizedHandler | null): void {
  handler = cb;
}

/**
 * fetch autenticado: injeta o Bearer e, em 401 EXPLÍCITO do servidor, dispara o
 * logout forçado (kick/block) com o `reason`. Erro de rede/timeout/5xx NÃO desloga —
 * só o 401 (senão a sombra de sinal deslogaria o agente em campo).
 */
export async function authedFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    const reason = await res
      .clone()
      .json()
      .then((b) => (b as { reason?: string })?.reason)
      .catch(() => undefined);
    handler?.(reason);
  }
  return res;
}
