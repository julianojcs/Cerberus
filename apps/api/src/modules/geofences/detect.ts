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
 * Detecta transições enter/exit comparando a posição atual com a anterior contra
 * cada geofence (círculo center+raio). `prev` null (primeira posição do agente)
 * é tratado como "fora" — logo, começar dentro de uma zona gera um `enter`.
 */
export function detectGeofenceEvents(
  current: GeoPoint,
  prev: GeoPoint | null,
  geofences: GeofenceLike[],
): GeofenceEvent[] {
  const events: GeofenceEvent[] = [];
  for (const g of geofences) {
    const [clng, clat] = g.center?.coordinates ?? [];
    if (clng == null || clat == null) continue;
    const center: GeoPoint = { lng: clng, lat: clat };
    const insideNow = haversineMeters(current, center) <= g.radiusMeters;
    const insideBefore = prev ? haversineMeters(prev, center) <= g.radiusMeters : false;
    if (insideNow && !insideBefore) {
      events.push({ geofenceId: String(g._id), geofenceName: g.name, type: 'enter' });
    } else if (!insideNow && insideBefore) {
      events.push({ geofenceId: String(g._id), geofenceName: g.name, type: 'exit' });
    }
  }
  return events;
}
