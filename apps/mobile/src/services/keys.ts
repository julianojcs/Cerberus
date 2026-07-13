import * as SecureStore from 'expo-secure-store';
import { config } from '../config';
import {
  generateKeyPair,
  publicFromSecret,
  type E2eeKeyPair,
  type E2eeRecipient,
} from '../shared/e2ee';

/**
 * Chaves E2EE do agente. A chave SECRETA é gerada no dispositivo e guardada no
 * armazenamento seguro (Keystore/Keychain) — nunca sai do aparelho. Só a pública
 * é registrada no diretório da API.
 *
 * Chave do SecureStore por usuário (só aceita alfanumérico, `.`, `-`, `_`).
 */
const SK_PREFIX = 'cerberus_e2ee_sk_';

function skKey(userId: string): string {
  return `${SK_PREFIX}${userId}`;
}

/** Garante o par de chaves local do usuário (gera na primeira vez). */
export async function ensureKeyPair(userId: string): Promise<E2eeKeyPair> {
  const existing = await SecureStore.getItemAsync(skKey(userId));
  if (existing) return { secretKey: existing, publicKey: publicFromSecret(existing) };
  const kp = generateKeyPair();
  await SecureStore.setItemAsync(skKey(userId), kp.secretKey);
  return kp;
}

/** Chave secreta local do usuário (null se ainda não provisionada). */
export async function getSecretKey(userId: string): Promise<string | null> {
  return SecureStore.getItemAsync(skKey(userId));
}

/**
 * Busca o diretório de chaves da operação e o devolve como destinatários de
 * envelope E2EE (id + chave pública). Reusado por texto e mídia.
 */
export async function fetchRecipients(
  session: { token: string },
  operationId: string,
): Promise<E2eeRecipient[]> {
  const res = await fetch(`${config.apiUrl}/operations/${operationId}/keys`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(`Erro ${res.status} ao obter chaves`);
  const dir = (await res.json()) as Array<{ id: string; publicKey: string }>;
  return dir.map((e) => ({ id: e.id, publicKey: e.publicKey }));
}

/**
 * Provisiona a chave E2EE do agente: garante o par local e registra a pública no
 * diretório da API. Lança em falha de rede/HTTP — quem chama decide se ignora
 * (o app segue e re-tenta no próximo login).
 */
export async function provisionKeys(session: { userId: string; token: string }): Promise<void> {
  const kp = await ensureKeyPair(session.userId);
  const res = await fetch(`${config.apiUrl}/auth/public-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ publicKey: kp.publicKey }),
  });
  if (!res.ok) throw new Error(`Erro ${res.status} ao registrar chave pública`);
}
