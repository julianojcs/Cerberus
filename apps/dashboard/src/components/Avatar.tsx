'use client';

import type { CSSProperties } from 'react';

/**
 * Iniciais (SEMPRE maiúsculas) de um nome: primeira letra das duas primeiras
 * palavras; se for uma única palavra, a primeira e a segunda letra dela.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const w = words[0] ?? '';
    return (w.length >= 2 ? w.slice(0, 2) : w || '?').toUpperCase();
  }
  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

/** Cor determinística (HSL) a partir do nome — fallback quando não há cor própria. */
function colorFromName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 42%)`;
}

/**
 * Avatar circular: imagem quando houver `imageUrl`, senão as INICIAIS sobre uma
 * cor (a cor própria da equipe/agente ou uma derivada do nome). Reuso no Chat.
 */
export function Avatar({
  name,
  imageUrl,
  color,
  size = 34,
}: {
  name: string;
  imageUrl?: string | null;
  color?: string | null;
  size?: number;
}) {
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    background: color || colorFromName(name),
    color: '#fff',
    fontSize: Math.round(size * 0.4),
    fontWeight: 700,
    lineHeight: 1,
    userSelect: 'none',
  };
  if (imageUrl) {
    return <img src={imageUrl} alt={name} style={{ ...base, objectFit: 'cover' }} />;
  }
  return (
    <span style={base} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}
