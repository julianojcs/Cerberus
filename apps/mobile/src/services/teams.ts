import { authedFetch } from './http';

/** Equipe do agente (subconjunto do TeamInfo do backend). */
export interface MyTeam {
  id: string;
  operationId: string;
  name: string;
  agentIds: string[];
  color?: string;
}

/**
 * Busca as equipes do agente na operação: `GET /teams` (escopado) filtrado pelas
 * que contêm o próprio `agentId`. Base para assinar os tópicos de equipe e enviar a
 * elas. Retorna `[]` se o agente não tiver `agentId` (não é agente de campo).
 */
export async function fetchMyTeams(
  session: { token: string; agentId?: string },
  operationId: string,
): Promise<MyTeam[]> {
  if (!session.agentId) return [];
  const res = await authedFetch(session.token, '/teams');
  if (!res.ok) throw new Error(`Erro ${res.status} ao obter equipes`);
  const all = (await res.json()) as MyTeam[];
  const agentId = session.agentId;
  return all.filter((t) => t.operationId === operationId && (t.agentIds ?? []).includes(agentId));
}
