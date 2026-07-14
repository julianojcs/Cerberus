import { authedFetch } from './http';
import { openMessage, sealMessage } from '../shared/e2ee';
import { fetchRecipients, getSecretKey } from './keys';
import type { Session } from './auth';
import type { BroadcastMessage } from './mqtt';

/**
 * Busca o HISTÓRICO de mensagens da operação (REST) e decifra o que for para este
 * agente — broadcasts, DMs e mensagens de equipe. Sem isso, o card do app só mostrava
 * o que chegasse AO VIVO na sessão (vazio ao abrir). Mais recentes primeiro.
 */
export async function fetchMessageHistory(
  session: Session,
  operationId: string,
  myId: string,
  secretKey: string | null,
): Promise<BroadcastMessage[]> {
  const res = await authedFetch(session.token, `/operations/${operationId}/messages`, {
    method: 'GET',
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    senderId: string;
    type: string;
    text?: string | null;
    ciphertext?: string | null;
    teamId?: string;
    recipientId?: string;
    capturedAt: string;
  }>;
  const out: BroadcastMessage[] = [];
  for (const m of raw) {
    const text =
      m.ciphertext && m.ciphertext.length > 0
        ? secretKey
          ? openMessage(m.ciphertext, myId, secretKey)
          : null
        : (m.text ?? null);
    if (text === null) continue; // não decifrável por este agente / vazio
    out.push({
      senderId: m.senderId,
      type: m.type,
      text,
      scope: m.teamId ? 'equipe' : m.recipientId ? 'dm' : 'central',
      teamId: m.teamId,
      capturedAt: m.capturedAt,
    });
  }
  return out.sort((a, b) => +new Date(b.capturedAt) - +new Date(a.capturedAt));
}

/**
 * Cifra e envia uma mensagem de texto à operação (E2EE). Monta o envelope por
 * destinatário a partir do diretório de chaves da operação; o servidor só recebe o
 * `ciphertext`. A própria mensagem volta pelo canal de broadcast (o agente também é
 * destinatário) e aparece no inbox já decifrada.
 */
export async function sendText(session: Session, operationId: string, text: string): Promise<void> {
  const secretKey = await getSecretKey(session.userId);
  if (!secretKey) throw new Error('Chave E2EE ausente — refaça o login.');

  const recipients = await fetchRecipients(session, operationId);
  if (recipients.length === 0) throw new Error('Nenhum destinatário com chave registrada.');

  const ciphertext = sealMessage(text, secretKey, recipients);
  const res = await authedFetch(session.token, `/operations/${operationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext }),
  });
  if (!res.ok) throw new Error(`Erro ${res.status} ao enviar mensagem`);
}

/**
 * Cifra e envia uma mensagem à EQUIPE (E2EE). Sela só para o SUBCONJUNTO de membros
 * da equipe com chave registrada (o próprio remetente é membro e entra também).
 * Publica no tópico da equipe (rota da 2b-1); o servidor só recebe o `ciphertext`.
 */
export async function sendTeamMessage(
  session: Session,
  operationId: string,
  team: { id: string; agentIds: string[] },
  text: string,
): Promise<void> {
  const secretKey = await getSecretKey(session.userId);
  if (!secretKey) throw new Error('Chave E2EE ausente — refaça o login.');

  const directory = await fetchRecipients(session, operationId);
  const members = new Set(team.agentIds);
  const recipients = directory.filter((r) => members.has(r.id));
  if (recipients.length === 0) throw new Error('Nenhum membro da equipe com chave registrada.');

  const ciphertext = sealMessage(text, secretKey, recipients);
  const res = await authedFetch(
    session.token,
    `/operations/${operationId}/teams/${team.id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext }),
    },
  );
  if (!res.ok) throw new Error(`Erro ${res.status} ao enviar à equipe`);
}
