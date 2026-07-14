import { generateKeyPair, publicFromSecret } from '@cerberus/shared';
import { api } from './api';

/**
 * Chaves E2EE do operador no navegador (Fase 5c/5e). A chave SECRETA é gerada
 * localmente e nunca sai do navegador; só a pública é registrada no diretório.
 *
 * **Em repouso (Fase 5e-1):** a secreta NÃO fica mais em texto claro. É cifrada
 * com uma passphrase do operador via WebCrypto — PBKDF2 (deriva chave AES) +
 * AES-GCM — e só o blob `{salt, iv, ct}` vai ao `localStorage`. A secreta em claro
 * existe apenas EM MEMÓRIA (`unlocked`) durante a sessão, após o desbloqueio; ao
 * recarregar a página é preciso desbloquear de novo (o `E2eeUnlockGate` cuida disso).
 */

// Chave em claro só em memória, por usuário. Limpa no lock/logout/reload.
const unlocked = new Map<string, string>();

/** Evento disparado quando a chave é desbloqueada — os painéis re-decifram. */
export const E2EE_UNLOCK_EVENT = 'cerberus:e2ee-unlock';
function notifyUnlock(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(E2EE_UNLOCK_EVENT));
}

const ENC_PREFIX = 'cerberus_e2ee_enc:'; // blob cifrado (novo)
const SK_PREFIX = 'cerberus_e2ee_sk:'; // texto claro LEGADO (fonte da migração)

const PBKDF2_ITERATIONS = 210_000;

interface EncBlob {
  v: 1;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64 (AES-GCM da secreta em base64)
}

/** Estado da chave — orquestra o modal de desbloqueio. */
export type KeyState = 'none' | 'locked' | 'legacy' | 'unlocked';

function encKey(userId: string): string {
  return `${ENC_PREFIX}${userId}`;
}
function skKey(userId: string): string {
  return `${SK_PREFIX}${userId}`;
}

// --- base64 <-> bytes ---
function b64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- WebCrypto ---
// Cast p/ `BufferSource`: o TS distingue `Uint8Array<ArrayBufferLike>` de
// `ArrayBufferView<ArrayBuffer>`, mas em runtime são sempre lastreados por ArrayBuffer.
const bs = (u: Uint8Array): BufferSource => u as BufferSource;

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    bs(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptSecret(secretKeyB64: string, passphrase: string): Promise<EncBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveAesKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    aes,
    bs(new TextEncoder().encode(secretKeyB64)),
  );
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function decryptSecret(blob: EncBlob, passphrase: string): Promise<string | null> {
  try {
    const aes = await deriveAesKey(passphrase, unb64(blob.salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(unb64(blob.iv)) },
      aes,
      bs(unb64(blob.ct)),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // passphrase errada / blob corrompido
  }
}

// --- API pública ---

/** Chave secreta em claro (só se DESBLOQUEADA nesta sessão). `null` senão. */
export function getSecretKey(userId: string): string | null {
  return unlocked.get(userId) ?? null;
}

/** Estado da chave do usuário no armazenamento local. */
export function keyState(userId: string): KeyState {
  if (typeof window === 'undefined') return 'none';
  if (unlocked.has(userId)) return 'unlocked';
  if (localStorage.getItem(encKey(userId))) return 'locked';
  if (localStorage.getItem(skKey(userId))) return 'legacy';
  return 'none';
}

/** Registra (idempotente) a pública derivada da secreta desbloqueada. */
async function registerPublic(userId: string): Promise<void> {
  const sk = unlocked.get(userId);
  if (sk) await api.registerPublicKey(publicFromSecret(sk)).catch(() => {});
}

/** Desbloqueia a chave existente (returning user). `true` se a passphrase abriu. */
export async function unlock(userId: string, passphrase: string): Promise<boolean> {
  const raw = localStorage.getItem(encKey(userId));
  if (!raw) return false;
  const sk = await decryptSecret(JSON.parse(raw) as EncBlob, passphrase);
  if (!sk) return false;
  unlocked.set(userId, sk);
  notifyUnlock();
  await registerPublic(userId); // reafirma a pública no diretório
  return true;
}

/** Migra a chave em texto claro (legado) para o blob cifrado com a passphrase. */
export async function migrateLegacy(userId: string, passphrase: string): Promise<boolean> {
  const plain = localStorage.getItem(skKey(userId));
  if (!plain) return false;
  const blob = await encryptSecret(plain, passphrase);
  localStorage.setItem(encKey(userId), JSON.stringify(blob));
  localStorage.removeItem(skKey(userId)); // apaga o texto claro
  unlocked.set(userId, plain);
  notifyUnlock();
  await registerPublic(userId);
  return true;
}

/** Cria a chave (primeira vez), protegida por passphrase, e registra a pública. */
export async function createProtectedKeys(userId: string, passphrase: string): Promise<void> {
  const kp = generateKeyPair();
  const blob = await encryptSecret(kp.secretKey, passphrase);
  localStorage.setItem(encKey(userId), JSON.stringify(blob));
  unlocked.set(userId, kp.secretKey);
  notifyUnlock();
  await api.registerPublicKey(kp.publicKey);
}

/** Trava a chave em memória (logout). NÃO remove o blob cifrado do disco. */
export function lock(userId: string): void {
  unlocked.delete(userId);
}
export function lockAll(): void {
  unlocked.clear();
}

/** Remove a chave do usuário (memória + disco). */
export function clearKeys(userId: string): void {
  unlocked.delete(userId);
  localStorage.removeItem(encKey(userId));
  localStorage.removeItem(skKey(userId));
}
