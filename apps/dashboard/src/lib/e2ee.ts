import { generateKeyPair, openMessage, publicFromSecret } from '@cerberus/shared';
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
 *
 * **Histórico de secretas (Fase 5e-2):** ao ROTACIONAR a chave, a secreta ANTIGA é
 * preservada (não apagada) — senão as mensagens seladas para a chave antiga ficariam
 * ilegíveis. Guardamos uma LISTA de secretas por usuário (mais nova primeiro): a nova
 * sela/deriva a pública; qualquer uma pode DECIFRAR (`openForMe` tenta todas). A lista
 * inteira é cifrada num único blob com a passphrase.
 */

// Secretas em claro só em memória, por usuário (mais nova primeiro). Limpa no lock/logout/reload.
const unlocked = new Map<string, string[]>();

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

// A lista de secretas é serializada como JSON antes de cifrar. Um blob LEGADO
// (5e-1) guarda uma única secreta em base64 pura — que nunca começa com '['; por
// isso detectamos o formato antigo pela ausência do colchete e o promovemos a `[sk]`.
function parseSecrets(decrypted: string): string[] {
  if (decrypted.startsWith('[')) {
    try {
      const arr = JSON.parse(decrypted) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch {
      /* cai no legado */
    }
  }
  return [decrypted]; // legado: uma secreta em base64
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

/** Chave secreta ATUAL em claro (a mais nova; só se DESBLOQUEADA nesta sessão). `null` senão. */
export function getSecretKey(userId: string): string | null {
  return unlocked.get(userId)?.[0] ?? null;
}

/** Todas as secretas desbloqueadas (atual + histórico de rotação), mais nova primeiro. */
export function getSecretKeys(userId: string): string[] {
  return unlocked.get(userId) ?? [];
}

/**
 * Decifra um envelope endereçado a `myDirId` tentando CADA secreta do usuário
 * (atual ∪ histórico). Após uma rotação, mensagens antigas foram seladas para uma
 * pública anterior; só a secreta correspondente as abre. `expectedSenderKey` (do
 * diretório) autentica o remetente igual em todas as tentativas.
 */
export function openForMe(
  userId: string,
  ciphertext: string,
  myDirId: string,
  expectedSenderKey?: string | string[],
): string | null {
  for (const sk of getSecretKeys(userId)) {
    const pt = openMessage(ciphertext, myDirId, sk, expectedSenderKey);
    if (pt !== null) return pt;
  }
  return null;
}

/** Estado da chave do usuário no armazenamento local. */
export function keyState(userId: string): KeyState {
  if (typeof window === 'undefined') return 'none';
  if (unlocked.has(userId)) return 'unlocked';
  if (localStorage.getItem(encKey(userId))) return 'locked';
  if (localStorage.getItem(skKey(userId))) return 'legacy';
  return 'none';
}

/** Registra (idempotente) a pública derivada da secreta ATUAL desbloqueada. */
async function registerPublic(userId: string): Promise<void> {
  const sk = unlocked.get(userId)?.[0];
  if (sk) await api.registerPublicKey(publicFromSecret(sk)).catch(() => {});
}

/** Persiste a lista de secretas (cifrada) e a mantém em memória. */
async function persistSecrets(userId: string, keys: string[], passphrase: string): Promise<void> {
  const blob = await encryptSecret(JSON.stringify(keys), passphrase);
  localStorage.setItem(encKey(userId), JSON.stringify(blob));
  unlocked.set(userId, keys);
}

/** Desbloqueia a chave existente (returning user). `true` se a passphrase abriu. */
export async function unlock(userId: string, passphrase: string): Promise<boolean> {
  const raw = localStorage.getItem(encKey(userId));
  if (!raw) return false;
  const decrypted = await decryptSecret(JSON.parse(raw) as EncBlob, passphrase);
  if (decrypted == null) return false;
  unlocked.set(userId, parseSecrets(decrypted));
  notifyUnlock();
  await registerPublic(userId); // reafirma a pública no diretório
  return true;
}

/** Migra a chave em texto claro (legado) para o blob cifrado com a passphrase. */
export async function migrateLegacy(userId: string, passphrase: string): Promise<boolean> {
  const plain = localStorage.getItem(skKey(userId));
  if (!plain) return false;
  await persistSecrets(userId, [plain], passphrase);
  localStorage.removeItem(skKey(userId)); // apaga o texto claro
  notifyUnlock();
  await registerPublic(userId);
  return true;
}

/** Cria a chave (primeira vez), protegida por passphrase, e registra a pública. */
export async function createProtectedKeys(userId: string, passphrase: string): Promise<void> {
  const kp = generateKeyPair();
  await persistSecrets(userId, [kp.secretKey], passphrase);
  notifyUnlock();
  await api.registerPublicKey(kp.publicKey);
}

/**
 * Rotaciona a chave (Fase 5e-2): gera um par novo, coloca a nova secreta À FRENTE da
 * lista (a antiga fica para decifrar o histórico), re-cifra tudo com a passphrase e
 * registra a nova pública — o servidor arquiva a anterior no `keyHistory` e limpa a
 * revogação. Exige a passphrase (re-cifra o blob); devolve a nova pública, ou `null`
 * se a passphrase não abrir o blob atual.
 */
export async function rotateKey(userId: string, passphrase: string): Promise<string | null> {
  const raw = localStorage.getItem(encKey(userId));
  if (!raw) return null;
  const decrypted = await decryptSecret(JSON.parse(raw) as EncBlob, passphrase);
  if (decrypted == null) return null; // passphrase errada
  const kp = generateKeyPair();
  await persistSecrets(userId, [kp.secretKey, ...parseSecrets(decrypted)], passphrase);
  notifyUnlock();
  await api.registerPublicKey(kp.publicKey); // versiona a anterior + limpa keyRevoked
  return kp.publicKey;
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
