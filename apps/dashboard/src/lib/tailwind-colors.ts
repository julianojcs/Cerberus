/**
 * Familias de cor PRIMARIA da paleta Tailwind (tom 500) usadas nas zonas.
 * Guardamos o TOKEN da familia (ex.: 'green') no banco; o tom 500 e o hex de
 * exibicao. Tons vizinhos (400/700) permitem derivar detalhes de componentes.
 */
export interface TailwindFamily {
  name: string;
  hex: string; // tom 500
  soft: string; // tom 400 (detalhes/realce)
  strong: string; // tom 700 (marcadores no mapa — ver resolveStrongColor)
}

export const TAILWIND_FAMILIES: TailwindFamily[] = [
  { name: 'red', hex: '#ef4444', soft: '#f87171', strong: '#b91c1c' },
  { name: 'orange', hex: '#f97316', soft: '#fb923c', strong: '#c2410c' },
  { name: 'amber', hex: '#f59e0b', soft: '#fbbf24', strong: '#b45309' },
  { name: 'yellow', hex: '#eab308', soft: '#facc15', strong: '#a16207' },
  { name: 'lime', hex: '#84cc16', soft: '#a3e635', strong: '#4d7c0f' },
  { name: 'green', hex: '#22c55e', soft: '#4ade80', strong: '#15803d' },
  { name: 'emerald', hex: '#10b981', soft: '#34d399', strong: '#047857' },
  { name: 'teal', hex: '#14b8a6', soft: '#2dd4bf', strong: '#0f766e' },
  { name: 'cyan', hex: '#06b6d4', soft: '#22d3ee', strong: '#0e7490' },
  { name: 'sky', hex: '#0ea5e9', soft: '#38bdf8', strong: '#0369a1' },
  { name: 'blue', hex: '#3b82f6', soft: '#60a5fa', strong: '#1d4ed8' },
  { name: 'indigo', hex: '#6366f1', soft: '#818cf8', strong: '#4338ca' },
  { name: 'violet', hex: '#8b5cf6', soft: '#a78bfa', strong: '#6d28d9' },
  { name: 'purple', hex: '#a855f7', soft: '#c084fc', strong: '#7e22ce' },
  { name: 'fuchsia', hex: '#d946ef', soft: '#e879f9', strong: '#a21caf' },
  { name: 'pink', hex: '#ec4899', soft: '#f472b6', strong: '#be185d' },
  { name: 'rose', hex: '#f43f5e', soft: '#fb7185', strong: '#be123c' },
  { name: 'slate', hex: '#64748b', soft: '#94a3b8', strong: '#334155' },
];

const BY_NAME: Record<string, TailwindFamily> = Object.fromEntries(
  TAILWIND_FAMILIES.map((f) => [f.name, f]),
);

/** Resolve o token de familia para o hex do tom 500 (fallback verde). */
export function resolveColor(family: string | undefined | null): string {
  return (family && BY_NAME[family]?.hex) || '#22c55e';
}

/**
 * Resolve o token para o hex do tom 700 — usado nos MARCADORES do mapa.
 *
 * Por que 700 e nao 500 nem 900: o 500 (cor da trilha) se perde sobre o mapa claro; o
 * 900 resolve o contraste mas COLAPSA as familias para quase-preto (cyan-900 #164e63,
 * green-900 #14532d, slate-900 #0f172a leem todas como cinza), deixando os agentes
 * indistinguiveis — que e justamente o proposito da cor por agente. O 700 contrasta e
 * PRESERVA o matiz. Com o pin PREENCHIDO nao e preciso ir a um tom extremo.
 * A trilha/rota segue no 500, que e a identidade do agente.
 */
export function resolveStrongColor(family: string | undefined | null): string {
  return (family && BY_NAME[family]?.strong) || '#15803d';
}
