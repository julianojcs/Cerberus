export interface GeoPoint {
  lng: number;
  lat: number;
}

export interface GeofenceLike {
  _id: unknown;
  name: string;
  /** 'circle' (padrão/retrocompat) | 'rectangle' | 'polygon'. */
  shape?: string;
  center?: { coordinates?: number[] } | null; // [lng, lat]
  radiusMeters?: number;
  widthMeters?: number;
  heightMeters?: number;
  rotationDeg?: number;
  vertices?: number[][]; // [[lng, lat], …]
  // --- Fase 5b — zonas avançadas ---
  /** Zona por equipe: só agentes desta equipe geram alerta (null = todas). */
  teamId?: string | null;
  /** Agendamento: janela horária diária em minutos-do-dia UTC (0–1439). */
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  /** Qual transição alerta: 'enter' | 'exit' | 'both' (padrão). */
  triggerOn?: string;
  /** Severidade herdada pelo alerta. */
  severity?: string;
}

export interface GeofenceEvent {
  geofenceId: string;
  geofenceName: string;
  type: 'enter' | 'exit';
  /** Novo estado de pertencimento após o evento (true = passou a estar dentro). */
  inside: boolean;
  /**
   * Fase 5b — se a transição deve ALERTAR (regra enter/exit da zona). O
   * pertencimento é sempre atualizado; o alerta só é criado quando `notify`.
   */
  notify: boolean;
  /** Severidade da zona (copiada para o alerta). */
  severity: string;
}

/** Contexto opcional da detecção (Fase 5b): hora + equipes do agente. */
export interface DetectOptions {
  /** Minuto-do-dia UTC do `capturedAt` (0–1439) — para o agendamento. */
  atUtcMin?: number;
  /** Equipes a que o agente pertence — para as zonas por equipe. */
  agentTeamIds?: string[];
}

/** Zona ativa no instante dado? (sem janela ⇒ sempre; janela pode cruzar a meia-noite). */
function isScheduledActive(g: GeofenceLike, atUtcMin?: number): boolean {
  const s = g.windowStartMin;
  const e = g.windowEndMin;
  if (s == null || e == null || s === e) return true;
  if (atUtcMin == null) return true; // sem hora ⇒ não filtra (fail-open)
  return s < e ? atUtcMin >= s && atUtcMin < e : atUtcMin >= s || atUtcMin < e;
}

const EARTH_RADIUS_M = 6371000;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/** Distância aproximada (haversine) em metros entre dois pontos {lng, lat}. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ponto dentro de um retângulo rotacionado. Converte o ponto para metros locais
 * (leste/norte) relativos ao centro, rotaciona `−rotationDeg` para alinhar aos eixos
 * do retângulo e testa a meia-largura/altura.
 */
function insideRectangle(
  p: GeoPoint,
  clng: number,
  clat: number,
  w: number,
  h: number,
  rotationDeg: number,
): boolean {
  const east = (p.lng - clng) * M_PER_DEG_LNG * Math.cos((clat * Math.PI) / 180);
  const north = (p.lat - clat) * M_PER_DEG_LAT;
  const th = (-rotationDeg * Math.PI) / 180;
  const x = east * Math.cos(th) - north * Math.sin(th);
  const y = east * Math.sin(th) + north * Math.cos(th);
  return Math.abs(x) <= w / 2 && Math.abs(y) <= h / 2;
}

/** Ray-casting: ponto dentro de um polígono (vertices `[[lng, lat], …]`). */
function pointInPolygon(p: GeoPoint, vertices: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const vi = vertices[i];
    const vj = vertices[j];
    if (!vi || !vj) continue;
    const xi = vi[0] ?? 0;
    const yi = vi[1] ?? 0;
    const xj = vj[0] ?? 0;
    const yj = vj[1] ?? 0;
    const intersect =
      yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Testa se o ponto está dentro da zona, despachando pela forma (círculo é o padrão). */
function isInside(current: GeoPoint, g: GeofenceLike): boolean {
  const shape = g.shape ?? 'circle';
  if (shape === 'polygon') {
    return Array.isArray(g.vertices) && g.vertices.length >= 3
      ? pointInPolygon(current, g.vertices)
      : false;
  }
  const [clng, clat] = g.center?.coordinates ?? [];
  if (clng == null || clat == null) return false;
  if (shape === 'rectangle') {
    if (g.widthMeters == null || g.heightMeters == null) return false;
    return insideRectangle(current, clng, clat, g.widthMeters, g.heightMeters, g.rotationDeg ?? 0);
  }
  return g.radiusMeters != null && haversineMeters(current, { lng: clng, lat: clat }) <= g.radiusMeters;
}

/**
 * Detecta transições enter/exit comparando a posição atual com o ESTADO ANTERIOR
 * de pertencimento (`insideBefore[geofenceId]`, default false = fora) contra cada
 * geofence (círculo/retângulo/polígono). Só emite evento quando o estado muda — logo,
 * uma vez dentro, não repete `enter`, e a saída gera `exit`. Estar dentro na primeira
 * leitura (sem estado) gera um único `enter`.
 */
export function detectGeofenceEvents(
  current: GeoPoint,
  insideBefore: Record<string, boolean>,
  geofences: GeofenceLike[],
  opts: DetectOptions = {},
): GeofenceEvent[] {
  const events: GeofenceEvent[] = [];
  for (const g of geofences) {
    // Fase 5b — zona por equipe: pula se a zona é de uma equipe e o agente não pertence.
    if (g.teamId && !(opts.agentTeamIds ?? []).includes(g.teamId)) continue;
    // Fase 5b — agendamento: pula (sem tracking) quando a zona está fora da janela.
    if (!isScheduledActive(g, opts.atUtcMin)) continue;

    const id = String(g._id);
    const insideNow = isInside(current, g);
    const wasInside = insideBefore[id] ?? false;
    if (insideNow === wasInside) continue; // sem transição
    const type = insideNow ? 'enter' : 'exit';
    // Fase 5b — regra de gatilho: o pertencimento sempre atualiza; o alerta só quando permitido.
    const trigger = g.triggerOn ?? 'both';
    events.push({
      geofenceId: id,
      geofenceName: g.name,
      type,
      inside: insideNow,
      notify: trigger === 'both' || trigger === type,
      severity: g.severity ?? 'medium',
    });
  }
  return events;
}
