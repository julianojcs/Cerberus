'use client';

import { decryptBytes } from '@cerberus/shared';
import { fetchAuthedBytes } from './api';
import { getCachedCiphertext, putCachedCiphertext } from './mediaCache';

/**
 * Baixa a mídia E2EE (do cache local persistente ou, na falta, do servidor — e então
 * persiste) e decifra. Retorna os bytes EM CLARO. Reusado pelo Image Viewer para
 * medir tamanho, exibir e permitir download; o ciphertext fica cifrado em repouso.
 */
export async function loadDecryptedBytes(
  path: string,
  k: string,
  n: string,
): Promise<Uint8Array> {
  let ciphertext = await getCachedCiphertext(path);
  if (!ciphertext) {
    ciphertext = await fetchAuthedBytes(path);
    void putCachedCiphertext(path, ciphertext);
  }
  const clear = decryptBytes(ciphertext, k, n);
  if (!clear) throw new Error('Falha ao decifrar a mídia');
  return clear;
}

/** Cria um object URL a partir de bytes em claro (o chamador revoga ao trocar/desmontar). */
export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

/** Tamanho legível (KB/MB) a partir de um número de bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
