/**
 * Familias de cor PRIMARIA da paleta Tailwind (tom 500) usadas nas zonas.
 * Guardamos o TOKEN da familia (ex.: 'green') no banco; o tom 500 e o hex de
 * exibicao. Tons vizinhos (400/900) permitem derivar detalhes de componentes.
 */
export interface TailwindFamily {
  name: string;
  hex: string; // tom 500
  soft: string; // tom 400 (detalhes/realce)
  strong: string; // tom 900 (marcadores no mapa — precisam contrastar com o fundo claro)
}

export const TAILWIND_FAMILIES: TailwindFamily[] = [
  { name: 'red', hex: '#ef4444', soft: '#f87171', strong: '#7f1d1d' },
  { name: 'orange', hex: '#f97316', soft: '#fb923c', strong: '#7c2d12' },
  { name: 'amber', hex: '#f59e0b', soft: '#fbbf24', strong: '#78350f' },
  { name: 'yellow', hex: '#eab308', soft: '#facc15', strong: '#713f12' },
  { name: 'lime', hex: '#84cc16', soft: '#a3e635', strong: '#365314' },
  { name: 'green', hex: '#22c55e', soft: '#4ade80', strong: '#14532d' },
  { name: 'emerald', hex: '#10b981', soft: '#34d399', strong: '#064e3b' },
  { name: 'teal', hex: '#14b8a6', soft: '#2dd4bf', strong: '#134e4a' },
  { name: 'cyan', hex: '#06b6d4', soft: '#22d3ee', strong: '#164e63' },
  { name: 'sky', hex: '#0ea5e9', soft: '#38bdf8', strong: '#0c4a6e' },
  { name: 'blue', hex: '#3b82f6', soft: '#60a5fa', strong: '#1e3a8a' },
  { name: 'indigo', hex: '#6366f1', soft: '#818cf8', strong: '#312e81' },
  { name: 'violet', hex: '#8b5cf6', soft: '#a78bfa', strong: '#4c1d95' },
  { name: 'purple', hex: '#a855f7', soft: '#c084fc', strong: '#581c87' },
  { name: 'fuchsia', hex: '#d946ef', soft: '#e879f9', strong: '#701a75' },
  { name: 'pink', hex: '#ec4899', soft: '#f472b6', strong: '#831843' },
  { name: 'rose', hex: '#f43f5e', soft: '#fb7185', strong: '#881337' },
  { name: 'slate', hex: '#64748b', soft: '#94a3b8', strong: '#0f172a' },
];

const BY_NAME: Record<string, TailwindFamily> = Object.fromEntries(
  TAILWIND_FAMILIES.map((f) => [f.name, f]),
);

/** Resolve o token de familia para o hex do tom 500 (fallback verde). */
export function resolveColor(family: string | undefined | null): string {
  return (family && BY_NAME[family]?.hex) || '#22c55e';
}

/**
 * Resolve o token para o hex do tom 900 — a versao MAIS FORTE da familia. Usado nos
 * marcadores do mapa: o tom 500 some sobre o mapa claro (traco fino de icone), o 900
 * crava. A trilha/rota segue no 500, que e a identidade do agente.
 */
export function resolveStrongColor(family: string | undefined | null): string {
  return (family && BY_NAME[family]?.strong) || '#14532d';
}
