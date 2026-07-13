import { generateKeyPair, publicFromSecret, type E2eeKeyPair } from '@cerberus/shared';
import { api } from './api';

/**
 * Chaves E2EE do operador no navegador. A chave SECRETA é gerada localmente e
 * nunca sai do navegador; só a pública é registrada no diretório da API.
 *
 * Limitação (MVP): a secreta fica em `localStorage` na estação confiável da
 * central. Endurecer (passphrase / WebCrypto não-extraível) é trabalho futuro.
 */
const SK_PREFIX = 'cerberus_e2ee_sk:';

function skKey(userId: string): string {
  return `${SK_PREFIX}${userId}`;
}

/** Garante um par de chaves local para o usuário (gera na primeira vez). */
export function ensureKeyPair(userId: string): E2eeKeyPair {
  const existing = localStorage.getItem(skKey(userId));
  if (existing) return { secretKey: existing, publicKey: publicFromSecret(existing) };
  const kp = generateKeyPair();
  localStorage.setItem(skKey(userId), kp.secretKey);
  return kp;
}

/** Chave secreta local do usuário (null se ainda não provisionada). */
export function getSecretKey(userId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(skKey(userId));
}

export function clearKeys(userId: string): void {
  localStorage.removeItem(skKey(userId));
}

/**
 * Provisiona a chave E2EE do operador: garante o par local e registra a pública
 * no diretório da API. Idempotente — re-registrar a mesma pública é inofensivo.
 */
export async function provisionKeys(userId: string): Promise<void> {
  const kp = ensureKeyPair(userId);
  await api.registerPublicKey(kp.publicKey);
}
