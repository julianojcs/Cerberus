import { authedFetch } from './http';

/**
 * Ping de sessão (~30s). Se a sessão foi revogada, o servidor responde 401 e o
 * `authedFetch` dispara o logout forçado. Erros de rede são ignorados (não desloga —
 * sombra de sinal é normal em campo).
 */
export async function pingSession(token: string): Promise<void> {
  try {
    await authedFetch(token, '/auth/session');
  } catch {
    /* offline/timeout — ignora */
  }
}
