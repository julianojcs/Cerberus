import { ROUTE_ARRIVAL_METERS, ROUTE_DEVIATION_METERS } from '@cerberus/shared';
import { haversineMeters, type GeoPoint } from '../geofences/detect.js';

/**
 * Progresso do agente sobre uma rota (issue #131): quão longe do traçado ele está
 * (desvio) e se já chegou. Roda no servidor, na ponte de ingest, a cada posição — por
 * isso é aritmética pura, sem I/O.
 */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/**
 * Distância (m) de um ponto a um segmento, projetando para metros locais em torno do
 * próprio ponto (equirretangular). Numa rota veicular os segmentos têm dezenas a
 * centenas de metros, escala em que a distorção da projeção é irrelevante — e evita
 * um haversine por vértice.
 */
function distanceToSegment(p: GeoPoint, a: [number, number], b: [number, number]): number {
  const kx = M_PER_DEG_LNG * Math.cos((p.lat * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const px = 0;
  const py = 0;
  const ax = (a[0] - p.lng) * kx;
  const ay = (a[1] - p.lat) * ky;
  const bx = (b[0] - p.lng) * kx;
  const by = (b[1] - p.lat) * ky;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // Segmento degenerado (vértices repetidos): distância ao próprio vértice.
  if (lenSq === 0) return Math.hypot(ax - px, ay - py);

  // Projeção escalar do ponto no segmento, presa a [0,1] para não sair das pontas.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/**
 * Menor distância (m) do ponto ao traçado. Percorre todos os segmentos: uma rota
 * urbana tem centenas de vértices, então é barato o bastante para rodar por posição
 * recebida.
 */
export function distanceToPath(p: GeoPoint, geometry: [number, number][]): number {
  if (geometry.length === 0) return Number.POSITIVE_INFINITY;
  const first = geometry[0]!;
  if (geometry.length === 1) return haversineMeters(p, { lng: first[0], lat: first[1] });

  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < geometry.length; i++) {
    const d = distanceToSegment(p, geometry[i - 1]!, geometry[i]!);
    if (d < min) min = d;
  }
  return min;
}

export interface RouteProgress {
  /** Distância (m) do agente ao traçado. */
  offRouteMeters: number;
  /** Passou do limiar de desvio ⇒ pede recálculo. */
  deviated: boolean;
  /** Distância (m) em linha reta até o destino. */
  toDestinationMeters: number;
  /** Entrou no raio de chegada ⇒ rota concluída. */
  arrived: boolean;
}

/**
 * Avalia a posição do agente contra a rota ativa. `arrived` tem precedência sobre
 * `deviated` na leitura do chamador: chegar ao destino por um caminho diferente do
 * traçado é sucesso, não desvio a recalcular.
 */
export function evaluateProgress(
  current: GeoPoint,
  geometry: [number, number][],
  destination: GeoPoint,
  opts: { deviationMeters?: number; arrivalMeters?: number } = {},
): RouteProgress {
  const deviationLimit = opts.deviationMeters ?? ROUTE_DEVIATION_METERS;
  const arrivalLimit = opts.arrivalMeters ?? ROUTE_ARRIVAL_METERS;

  const offRouteMeters = distanceToPath(current, geometry);
  const toDestinationMeters = haversineMeters(current, destination);
  const arrived = toDestinationMeters <= arrivalLimit;

  return {
    offRouteMeters,
    deviated: !arrived && offRouteMeters > deviationLimit,
    toDestinationMeters,
    arrived,
  };
}
