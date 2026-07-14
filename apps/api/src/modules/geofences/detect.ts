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
}

export interface GeofenceEvent {
  geofenceId: string;
  geofenceName: string;
  type: 'enter' | 'exit';
  /** Novo estado de pertencimento após o evento (true = passou a estar dentro). */
  inside: boolean;
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
): GeofenceEvent[] {
  const events: GeofenceEvent[] = [];
  for (const g of geofences) {
    const id = String(g._id);
    const insideNow = isInside(current, g);
    const wasInside = insideBefore[id] ?? false;
    if (insideNow === wasInside) continue; // sem transição
    events.push({
      geofenceId: id,
      geofenceName: g.name,
      type: insideNow ? 'enter' : 'exit',
      inside: insideNow,
    });
  }
  return events;
}
