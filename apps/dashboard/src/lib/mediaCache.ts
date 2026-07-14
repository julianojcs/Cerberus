'use client';

/**
 * Cache local PERSISTENTE (IndexedDB) do CIPHERTEXT das mídias, chaveado pelo `path`
 * (id do blob no GridFS — imutável). Evita re-baixar do servidor a cada carregamento.
 *
 * Segurança em repouso: guardamos o blob **cifrado** (E2EE), exatamente como o
 * servidor o serve — a chave/nonce de decifração NUNCA é persistida (vem no envelope
 * por mensagem, só em memória). Assim o cache local é inútil sem a chave E2EE.
 */

const DB_NAME = 'cerberus-media';
const STORE = 'ciphertext';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Lê o ciphertext cacheado (ou `null` se ausente/indisponível). */
export async function getCachedCiphertext(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as ArrayBuffer | undefined;
        resolve(v ? new Uint8Array(v) : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Grava o ciphertext no cache (best-effort — falha silenciosa). */
export async function putCachedCiphertext(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(buf, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
