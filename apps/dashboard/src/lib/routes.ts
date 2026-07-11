/**
 * Rotas/segmentos de trajeto. Uma "rota" e uma sequencia continua de posicoes do
 * agente; um intervalo grande SEM transmissao quebra o trajeto (o app parou de
 * enviar e voltou noutro lugar) — esse pulo NAO deve virar linha reta no mapa.
 */
export const TRAIL_GAP_MS = 5 * 60 * 1000; // 5 min sem posicao = quebra de rota

/**
 * Paleta de cores por agente (viva e distinguivel entre si). Evita o vermelho
 * `#c1121f` reservado a UI ao vivo (marcador/rota atual) e ao broadcast.
 */
export const AGENT_PALETTE = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#eab308', // yellow
  '#d946ef', // fuchsia
];

/** Atribui uma cor estavel a cada agente (ordem deterministica por id). */
export function assignAgentColors(agentIds: string[]): Record<string, string> {
  const ids = [...new Set(agentIds)].sort();
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    out[id] = AGENT_PALETTE[i % AGENT_PALETTE.length];
  });
  return out;
}

export interface TimedPoint {
  agentId: string;
  lng: number;
  lat: number;
  capturedAt: string;
}

export interface Route {
  id: string;
  agentId: string;
  points: [number, number][]; // [lng, lat]
  start: number; // ms epoch (primeira posicao da rota)
  end: number; // ms epoch (ultima posicao da rota)
}

/** Divide uma sequencia (asc por tempo) em segmentos, quebrando em gaps > gapMs. */
export function splitSegments<T extends { lng: number; lat: number; capturedAt: string }>(
  points: T[],
  gapMs = TRAIL_GAP_MS,
): [number, number][][] {
  const asc = [...points].sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt));
  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  let last = 0;
  for (const p of asc) {
    if (p.lat == null || p.lng == null) continue;
    const cap = +new Date(p.capturedAt);
    if (cur.length && cap - last > gapMs) {
      segments.push(cur);
      cur = [];
    }
    cur.push([p.lng, p.lat]);
    last = cap;
  }
  if (cur.length) segments.push(cur);
  return segments;
}

/** Constroi as rotas (com inicio/fim) por agente a partir do historico de posicoes. */
export function buildRoutes(
  positions: TimedPoint[],
  gapMs = TRAIL_GAP_MS,
): Record<string, Route[]> {
  const byAgent: Record<string, TimedPoint[]> = {};
  for (const p of positions) {
    if (p.lat == null || p.lng == null) continue;
    (byAgent[p.agentId] ??= []).push(p);
  }
  const out: Record<string, Route[]> = {};
  for (const [agentId, pts] of Object.entries(byAgent)) {
    const asc = [...pts].sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt));
    const routes: Route[] = [];
    let cur: [number, number][] = [];
    let start = 0;
    let last = 0;
    let idx = 0;
    const flush = () => {
      if (cur.length > 0) {
        routes.push({ id: `${agentId}-${idx++}`, agentId, points: cur, start, end: last });
        cur = [];
      }
    };
    for (const p of asc) {
      const cap = +new Date(p.capturedAt);
      if (cur.length && cap - last > gapMs) flush();
      if (cur.length === 0) start = cap;
      cur.push([p.lng, p.lat]);
      last = cap;
    }
    flush();
    out[agentId] = routes;
  }
  return out;
}
