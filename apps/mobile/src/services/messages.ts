import { config } from '../config';
import { sealMessage, type E2eeRecipient } from '../shared/e2ee';
import { getSecretKey } from './keys';
import type { Session } from './auth';

interface KeyDirectoryEntry {
  id: string;
  publicKey: string;
  role: string;
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

  const dirRes = await fetch(`${config.apiUrl}/operations/${operationId}/keys`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!dirRes.ok) throw new Error(`Erro ${dirRes.status} ao obter chaves`);
  const directory = (await dirRes.json()) as KeyDirectoryEntry[];
  const recipients: E2eeRecipient[] = directory.map((e) => ({ id: e.id, publicKey: e.publicKey }));
  if (recipients.length === 0) throw new Error('Nenhum destinatário com chave registrada.');

  const ciphertext = sealMessage(text, secretKey, recipients);
  const res = await fetch(`${config.apiUrl}/operations/${operationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ciphertext }),
  });
  if (!res.ok) throw new Error(`Erro ${res.status} ao enviar mensagem`);
}
