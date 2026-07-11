const EARTH_R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Rumo (bússola, 0=N, 90=L) do ponto `from` para o ponto `to`, em graus [0,360). */
export function bearingDeg(from: [number, number], to: [number, number]): number {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Ponto a `distanceMeters` de `from` no rumo `bearing`. */
export function destinationPoint(
  from: [number, number],
  distanceMeters: number,
  bearing: number,
): [number, number] {
  const [lng, lat] = from;
  const d = distanceMeters / EARTH_R;
  const t = toRad(bearing);
  const p1 = toRad(lat);
  const l1 = toRad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 +
    Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(l2), toDeg(p2)];
}

export interface AlertFocus {
  lng: number; // ponto NA BORDA da zona (no raio centro→posição do alerta)
  lat: number;
  bearing: number; // direção da seta (sentido do deslocamento na rota)
  type: 'enter' | 'exit';
}

/**
 * Rumo do DESLOCAMENTO ao longo da rota no ponto mais próximo de `target` (o local
 * do cruzamento). Usa o vetor ponto-anterior → ponto-do-cruzamento (senão o ponto
 * seguinte). Devolve null se não houver pontos suficientes. É essa a direção da
 * seta do alerta — o sentido em que o agente cruzou a borda, não o raio da zona.
 */
export function routeBearingAt(
  routesPoints: [number, number][][],
  target: [number, number],
): number | null {
  let best: { d: number; seg: [number, number][]; i: number } | null = null;
  for (const seg of routesPoints) {
    for (let i = 0; i < seg.length; i++) {
      const dx = seg[i][0] - target[0];
      const dy = seg[i][1] - target[1];
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { d, seg, i };
    }
  }
  if (!best) return null;
  const { seg, i } = best;
  if (i > 0) return bearingDeg(seg[i - 1], seg[i]);
  if (i + 1 < seg.length) return bearingDeg(seg[i], seg[i + 1]);
  return null;
}

/**
 * Dado o ponto onde o alerta foi registrado e a zona (centro + raio), devolve o
 * ponto na BORDA (no raio centro→ponto) e a direção da seta: entrada aponta para
 * dentro (para o centro), saída aponta para fora.
 */
export function alertBorderFocus(
  alert: [number, number],
  zoneCenter: [number, number],
  radiusMeters: number,
  type: 'enter' | 'exit',
): AlertFocus {
  const theta = bearingDeg(zoneCenter, alert); // centro → posição do alerta
  const [lng, lat] = destinationPoint(zoneCenter, radiusMeters, theta);
  const bearing = type === 'enter' ? (theta + 180) % 360 : theta;
  return { lng, lat, bearing, type };
}
