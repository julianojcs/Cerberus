'use client';

import { useEffect, useState } from 'react';
import { fetchBlobUrl } from '@/lib/api';

/**
 * <img> de recurso protegido: baixa `path` com o Bearer token, converte em object
 * URL e renderiza. Necessário porque a tag <img> não envia header Authorization.
 * Libera o object URL ao desmontar.
 */
export function AuthImage({
  path,
  alt,
  style,
  onClick,
}: {
  path: string;
  alt?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(false);
    fetchBlobUrl(path)
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
  }, [path]);

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
