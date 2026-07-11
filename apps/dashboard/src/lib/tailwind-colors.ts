/**
 * Familias de cor PRIMARIA da paleta Tailwind (tom 500) usadas nas zonas.
 * Guardamos o TOKEN da familia (ex.: 'green') no banco; o tom 500 e o hex de
 * exibicao. Tons vizinhos (400/600) permitem derivar detalhes de componentes.
 */
export interface TailwindFamily {
  name: string;
  hex: string; // tom 500
  soft: string; // tom 400 (detalhes/realce)
}

export const TAILWIND_FAMILIES: TailwindFamily[] = [
  { name: 'red', hex: '#ef4444', soft: '#f87171' },
  { name: 'orange', hex: '#f97316', soft: '#fb923c' },
  { name: 'amber', hex: '#f59e0b', soft: '#fbbf24' },
  { name: 'yellow', hex: '#eab308', soft: '#facc15' },
  { name: 'lime', hex: '#84cc16', soft: '#a3e635' },
  { name: 'green', hex: '#22c55e', soft: '#4ade80' },
  { name: 'emerald', hex: '#10b981', soft: '#34d399' },
  { name: 'teal', hex: '#14b8a6', soft: '#2dd4bf' },
  { name: 'cyan', hex: '#06b6d4', soft: '#22d3ee' },
  { name: 'sky', hex: '#0ea5e9', soft: '#38bdf8' },
  { name: 'blue', hex: '#3b82f6', soft: '#60a5fa' },
  { name: 'indigo', hex: '#6366f1', soft: '#818cf8' },
  { name: 'violet', hex: '#8b5cf6', soft: '#a78bfa' },
  { name: 'purple', hex: '#a855f7', soft: '#c084fc' },
  { name: 'fuchsia', hex: '#d946ef', soft: '#e879f9' },
  { name: 'pink', hex: '#ec4899', soft: '#f472b6' },
  { name: 'rose', hex: '#f43f5e', soft: '#fb7185' },
  { name: 'slate', hex: '#64748b', soft: '#94a3b8' },
];

const BY_NAME: Record<string, TailwindFamily> = Object.fromEntries(
  TAILWIND_FAMILIES.map((f) => [f.name, f]),
);

/** Resolve o token de familia para o hex do tom 500 (fallback verde). */
export function resolveColor(family: string | undefined | null): string {
  return (family && BY_NAME[family]?.hex) || '#22c55e';
}
