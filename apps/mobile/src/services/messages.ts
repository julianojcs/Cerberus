import { authedFetch } from './http';
import { sealMessage } from '../shared/e2ee';
import { fetchRecipients, getSecretKey } from './keys';
import type { Session } from './auth';

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
