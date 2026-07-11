export interface GeoPoint {
  lng: number;
  lat: number;
}

export interface GeofenceLike {
  _id: unknown;
  name: string;
  center?: { coordinates?: number[] } | null; // [lng, lat]
  radiusMeters: number;
}

export interface GeofenceEvent {
  geofenceId: string;
  geofenceName: string;
  type: 'enter' | 'exit';
  /** Novo estado de pertencimento após o evento (true = passou a estar dentro). */
  inside: boolean;
}

const EARTH_RADIUS_M = 6371000;

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
 * Detecta transições enter/exit comparando a posição atual com o ESTADO ANTERIOR
 * de pertencimento (`insideBefore[geofenceId]`, default false = fora) contra cada
 * geofence (círculo center+raio). Só emite evento quando o estado muda — logo,
 * uma vez dentro, não repete `enter`, e a saída gera `exit`. Estar dentro na
 * primeira leitura (sem estado) gera um único `enter`.
 */
export function detectGeofenceEvents(
  current: GeoPoint,
  insideBefore: Record<string, boolean>,
  geofences: GeofenceLike[],
): GeofenceEvent[] {
  const events: GeofenceEvent[] = [];
  for (const g of geofences) {
    const [clng, clat] = g.center?.coordinates ?? [];
    if (clng == null || clat == null) continue;
    const id = String(g._id);
    const insideNow = haversineMeters(current, { lng: clng, lat: clat }) <= g.radiusMeters;
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
