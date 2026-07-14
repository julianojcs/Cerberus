'use client';

import { useEffect, useState } from 'react';
import { decryptBytes } from '@cerberus/shared';
import { fetchAuthedBytes, fetchBlobUrl } from '@/lib/api';
import { getCachedCiphertext, putCachedCiphertext } from '@/lib/mediaCache';

/**
 * Cache de object URLs por (path+chave+mime) na sessão. Ao trocar de chat o
 * componente desmonta/remonta; sem cache, re-baixaria/re-decifraria a mídia a cada
 * volta. Com o cache, cada imagem é resolvida UMA vez e reusada. Não revogamos os
 * URLs (o cache os detém enquanto a aba viver — o volume de mídia da operação é baixo).
 */
const blobUrlCache = new Map<string, string>();

/**
 * <img> de recurso protegido: baixa `path` com o Bearer token, converte em object
 * URL e renderiza. Necessário porque a tag <img> não envia header Authorization.
 * Libera o object URL ao desmontar.
 *
 * Se `mediaKey` for passado, a mídia é E2EE: baixa o blob CIFRADO e decifra no
 * navegador (secretbox) antes de exibir — o servidor nunca serviu a imagem em claro.
 */
export function AuthImage({
  path,
  alt,
  style,
  onClick,
  mediaKey,
  mime,
}: {
  path: string;
  alt?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  mediaKey?: { k: string; n: string } | null;
  mime?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Depende dos VALORES da chave (não do objeto): senão cada re-render recria o
  // `{k,n}` e o efeito rebaixa/redecifra a imagem à toa (piscada periódica).
  const k = mediaKey?.k;
  const n = mediaKey?.n;

  useEffect(() => {
    const cacheKey = `${path}|${k ?? ''}|${n ?? ''}|${mime ?? ''}`;
    const cached = blobUrlCache.get(cacheKey);
    if (cached) {
      // Já resolvida nesta sessão (ex.: ao voltar para este chat) — reusa, sem re-baixar.
      setUrl(cached);
      setError(false);
      return;
    }
    let active = true;
    setUrl(null);
    setError(false);

    // Ciphertext: do cache local persistente (IndexedDB) ou, na falta, do servidor
    // (e então persiste). O blob fica cifrado em repouso — a chave só existe em memória.
    const ciphertext = () =>
      getCachedCiphertext(path).then(
        (cached) =>
          cached ??
          fetchAuthedBytes(path).then((bytes) => {
            void putCachedCiphertext(path, bytes);
            return bytes;
          }),
      );

    const load =
      k && n
        ? ciphertext().then((bytes) => {
          const clear = decryptBytes(bytes, k, n);
          if (!clear) throw new Error('Falha ao decifrar a mídia');
          // Copia para um ArrayBuffer próprio (o Blob não aceita ArrayBufferLike genérico).
          const buf = clear.buffer.slice(
            clear.byteOffset,
            clear.byteOffset + clear.byteLength,
          ) as ArrayBuffer;
          return URL.createObjectURL(new Blob([buf], { type: mime ?? 'image/jpeg' }));
        })
      : fetchBlobUrl(path);

    load
      .then((u) => {
        blobUrlCache.set(cacheKey, u); // retém p/ reuso ao remontar (troca de chat)
        if (active) setUrl(u);
      })
      .catch(() => active && setError(true));
    return () => {
      active = false; // não revoga: o cache detém o URL para a próxima montagem
    };
  }, [path, k, n, mime]);

  if (error) {
    return (
      <div style={{ ...style, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
        ✕
      </div>
    );
  }
  // Placeholder reserva um aspecto (para o masonry nao colapsar enquanto carrega);
  // o `style` do chamador (ex.: altura fixa no lightbox) sobrescreve.
  if (!url) return <div style={{ aspectRatio: '3 / 4', ...style, background: 'var(--border)' }} />;
  return <img src={url} alt={alt ?? 'mídia'} style={style} onClick={onClick} />;
}
