import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

/**
 * Criptografia ponta-a-ponta (E2EE) das mensagens táticas. Usa NaCl (tweetnacl):
 * X25519 para identidade (`box`) + XSalsa20-Poly1305 para o conteúdo (`secretbox`).
 * O servidor/broker nunca veem o conteúdo — só o envelope opaco.
 */
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

/** Par de chaves X25519 (base64). A chave SECRETA nunca sai do dispositivo/navegador. */
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

/**
 * Envelope E2EE, codificado como string JSON base64 (vai no campo `ciphertext`): a
 * mensagem é cifrada UMA vez com uma chave simétrica aleatória `K` (secretbox), e `K`
 * é embrulhada POR DESTINATÁRIO (box). Assim um broadcast 1→N não revela o conteúdo
 * ao servidor e cada agente decifra só o seu envelope.
 */
interface Envelope {
  v: 1;
  ct: string; // secretbox(plaintext, n0, K)
  n0: string; // nonce da mensagem
  spk: string; // chave pública do remetente
  envs: { rid: string; ek: string; n: string }[]; // K embrulhada por destinatário
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

/**
 * Cifra um bloco de bytes (ex.: uma imagem) com uma chave simétrica nova (secretbox).
 * Devolve o binário cifrado + a chave/nonce em base64 — que devem viajar cifrados no
 * envelope da metadata (via `sealMessage`), nunca em claro. Usado no E2EE de mídia:
 * o blob opaco vai ao GridFS; a chave só existe dentro do envelope por destinatário.
 */
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
 * Decifra o envelope para o destinatário `myId`. Devolve `null` se não for para ele,
 * se a chave/assinatura não bater, ou se não for um envelope E2EE válido (ex.: uma
 * mensagem de sistema em claro no mesmo canal).
 *
 * **Autenticação do remetente (Fase 5c):** quando `expectedSenderKey` é informado (a
 * chave pública do remetente segundo o DIRETÓRIO), o `spk` auto-reportado no envelope
 * precisa bater — senão a mensagem é rejeitada (`null`). Sem isso, um remetente
 * malicioso poderia forjar a identidade (`senderId`) de outro. Omitir mantém o
 * comportamento antigo (sem verificação) para chamadas legadas.
 */
export function openMessage(
  ciphertext: string,
  myId: string,
  mySecretKey: string,
  expectedSenderKey?: string,
): string | null {
  try {
    const env = JSON.parse(encodeUTF8(decodeBase64(ciphertext))) as Envelope;
    if (env.v !== 1 || !Array.isArray(env.envs)) return null;
    // Anti-spoofing: o spk do envelope deve ser o do remetente registrado no diretório.
    if (expectedSenderKey && env.spk !== expectedSenderKey) return null;
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
