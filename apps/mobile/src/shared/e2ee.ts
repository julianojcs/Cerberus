/**
 * Espelho local dos helpers E2EE de `@cerberus/shared` (src/e2ee.ts).
 *
 * O app móvel fica FORA dos workspaces npm, então mantemos aqui uma cópia dos
 * helpers de criptografia ponta-a-ponta. Mantenha em sincronia com
 * packages/shared/src/e2ee.ts.
 *
 * NaCl (tweetnacl): X25519 para identidade (`box`) + XSalsa20-Poly1305 para o
 * conteúdo (`secretbox`). O servidor/broker nunca veem o conteúdo — só o envelope.
 * Requer `crypto.getRandomValues` (polyfill em src/polyfills.ts).
 */
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

/** Par de chaves X25519 (base64). A chave SECRETA nunca sai do dispositivo. */
export interface E2eeKeyPair {
  publicKey: string;
  secretKey: string;
}

export function generateKeyPair(): E2eeKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
}

/** Deriva a chave pública a partir da secreta (registra sem guardar as duas). */
export function publicFromSecret(secretKey: string): string {
  return encodeBase64(nacl.box.keyPair.fromSecretKey(decodeBase64(secretKey)).publicKey);
}

/** Destinatário do envelope: um id estável (agentId/userId) + sua chave pública. */
export interface E2eeRecipient {
  id: string;
  publicKey: string;
}

interface Envelope {
  v: 1;
  ct: string;
  n0: string;
  spk: string;
  envs: { rid: string; ek: string; n: string }[];
}

/** Cifra `plaintext` para todos os `recipients`. Devolve o envelope (string). */
export function sealMessage(
  plaintext: string,
  senderSecretKey: string,
  recipients: E2eeRecipient[],
): string {
  const K = nacl.randomBytes(nacl.secretbox.keyLength);
  const n0 = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(decodeUTF8(plaintext), n0, K);
  const sk = decodeBase64(senderSecretKey);
  const envs = recipients.map((r) => {
    const n = nacl.randomBytes(nacl.box.nonceLength);
    const ek = nacl.box(K, n, decodeBase64(r.publicKey), sk);
    return { rid: r.id, ek: encodeBase64(ek), n: encodeBase64(n) };
  });
  const env: Envelope = {
    v: 1,
    ct: encodeBase64(ct),
    n0: encodeBase64(n0),
    spk: publicFromSecret(senderSecretKey),
    envs,
  };
  return encodeBase64(decodeUTF8(JSON.stringify(env)));
}

/** Cifra bytes (ex.: imagem) com uma chave simétrica nova. Devolve cipher + chave/nonce. */
export function encryptBytes(bytes: Uint8Array): {
  cipher: Uint8Array;
  key: string;
  nonce: string;
} {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const cipher = nacl.secretbox(bytes, nonce, key);
  return { cipher, key: encodeBase64(key), nonce: encodeBase64(nonce) };
}

/** Decifra bytes cifrados por `encryptBytes` com a chave/nonce (base64). `null` se falhar. */
export function decryptBytes(cipher: Uint8Array, key: string, nonce: string): Uint8Array | null {
  return nacl.secretbox.open(cipher, decodeBase64(nonce), decodeBase64(key));
}

/**
 * Decifra o envelope para o destinatário `myId`. Devolve `null` se não for para
 * ele, se a chave não bater, ou se não for um envelope E2EE válido (ex.: uma
 * mensagem de sistema em claro no mesmo canal).
 */
export function openMessage(ciphertext: string, myId: string, mySecretKey: string): string | null {
  try {
    const env = JSON.parse(encodeUTF8(decodeBase64(ciphertext))) as Envelope;
    if (env.v !== 1 || !Array.isArray(env.envs)) return null;
    const mine = env.envs.find((e) => e.rid === myId);
    if (!mine) return null;
    const K = nacl.box.open(
      decodeBase64(mine.ek),
      decodeBase64(mine.n),
      decodeBase64(env.spk),
      decodeBase64(mySecretKey),
    );
    if (!K) return null;
    const pt = nacl.secretbox.open(decodeBase64(env.ct), decodeBase64(env.n0), K);
    return pt ? encodeUTF8(pt) : null;
  } catch {
    return null;
  }
}
