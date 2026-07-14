'use client';

import { useEffect, useState } from 'react';
import { decryptBytes } from '@cerberus/shared';
import { fetchAuthedBytes, fetchBlobUrl } from '@/lib/api';

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
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(false);

    const load =
      k && n
        ? fetchAuthedBytes(path).then((bytes) => {
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
        if (active) {
          objectUrl = u;
          setUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
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
