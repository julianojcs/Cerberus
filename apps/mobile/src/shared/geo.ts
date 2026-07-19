/**
 * Geometria de navegação no aparelho (issue #131).
 *
 * Tudo aqui roda a cada fix de GPS, sem rede: uma vez baixado, o traçado é seguido
 * offline. Por isso nada de biblioteca geoespacial — são quatro fórmulas.
 *
 * **Convenção de eixos:** a API entrega `[lng, lat]` (GeoJSON) e o Leaflet consome
 * `[lat, lng]`. A inversão acontece EXCLUSIVAMENTE em `toLatLng`/`toLatLngPath` deste
 * arquivo — ver .claude/rules/geospatial-coordinates.md. Trocar os eixos é a causa nº 1
 * de marcador no oceano; centralizar a transposição num ponto é o que impede isso.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Converte UM par GeoJSON `[lng, lat]` para a convenção de mapa `{ lat, lng }`. */
export function toLatLng(coord: [number, number]): LatLng {
  return { lat: coord[1], lng: coord[0] };
}

/** Converte o traçado GeoJSON inteiro para a ordem que o Leaflet espera. */
export function toLatLngPath(geometry: [number, number][]): LatLng[] {
  return geometry.map(toLatLng);
}

/** Distância em metros sobre a esfera (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumo inicial de `from` para `to`, em graus horários a partir do norte (0–360). */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = from.lat * DEG;
  const lat2 = to.lat * DEG;
  const dLng = (to.lng - from.lng) * DEG;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Rosa dos ventos em pt-BR — é o que resta quando não há instrução de via (fallback). */
const ROSE = ['norte', 'nordeste', 'leste', 'sudeste', 'sul', 'sudoeste', 'oeste', 'noroeste'];
export function compassRose(degrees: number): string {
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return ROSE[index];
}

/**
 * Traçado pré-processado. `suffix[i]` é a distância de `points[i]` até o FIM do
 * trajeto: com ela o restante vira uma soma O(1) por vértice em vez de percorrer o
 * traçado inteiro a cada fix (uma rota urbana passa de mil vértices).
 */
export interface RoutePath {
  points: LatLng[];
  suffix: number[];
}

export function buildRoutePath(geometry: [number, number][]): RoutePath {
  const points = toLatLngPath(geometry);
  const suffix = new Array<number>(points.length).fill(0);
  for (let i = points.length - 2; i >= 0; i -= 1) {
    suffix[i] = suffix[i + 1] + haversineMeters(points[i], points[i + 1]);
  }
  return { points, suffix };
}

/** Onde está quem percorreu N metros do traçado, e para onde aponta. */
export interface PathCursor {
  pos: LatLng;
  /** Rumo do segmento atual — a direção em que o trajeto segue naquele ponto. */
  heading: number;
  /** `true` quando a distância pedida alcançou (ou passou) o fim do traçado. */
  done: boolean;
}

/**
 * Inverso do `progressAlongPath`: em vez de "onde estou em relação ao traçado", devolve
 * "onde eu estaria depois de andar N metros por ele". Existe para a SIMULAÇÃO de
 * deslocamento — sem sair andando na rua, é assim que se gera uma sequência de posições
 * fisicamente coerente (na via, com rumo real) para exercitar o turn-by-turn.
 *
 * Usa o `suffix` já pré-computado pelo `buildRoutePath`: `suffix[i]` é o que falta de
 * `points[i]` até o fim, então o total é `suffix[0]` e a busca do segmento é uma
 * varredura simples sobre um vetor decrescente.
 */
export function pointAtDistance(path: RoutePath, metersFromStart: number): PathCursor {
  const { points, suffix } = path;
  if (points.length === 0) return { pos: { lat: 0, lng: 0 }, heading: 0, done: true };
  if (points.length === 1) return { pos: points[0], heading: 0, done: true };

  const total = suffix[0];
  if (metersFromStart >= total) {
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    return { pos: last, heading: bearingDegrees(prev, last), done: true };
  }
  const travelled = Math.max(0, metersFromStart);
  const remaining = total - travelled;

  // `suffix` decresce: o segmento é o primeiro cujo fim já passou do que resta.
  let i = 0;
  while (i < points.length - 2 && suffix[i + 1] > remaining) i += 1;

  const a = points[i];
  const b = points[i + 1];
  const segLen = suffix[i] - suffix[i + 1];
  const t = segLen > 0 ? (suffix[i] - remaining) / segLen : 0;
  return {
    pos: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    heading: bearingDegrees(a, b),
    done: false,
  };
}

export interface PathProgress {
  /** Vértice inicial do segmento mais próximo da posição. */
  index: number;
  /** Distância (m) da posição ao traçado — o quanto o agente está fora da rota. */
  offRouteMeters: number;
  /** Distância (m) que falta até o destino, medida SOBRE o traçado (não em linha reta). */
  remainingMeters: number;
}

/**
 * Projeção equirretangular local do ponto no segmento. Em trechos de dezenas a
 * centenas de metros o erro em relação à geodésica é muito menor que o do próprio GPS,
 * e evita trigonometria esférica em cada vértice a cada fix.
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): LatLng {
  const kx = Math.cos(p.lat * DEG); // achata a longitude na latitude local
  const ax = a.lng * kx;
  const bx = b.lng * kx;
  const px = p.lng * kx;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / len2));
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Onde o agente está em relação ao traçado. Varre todos os segmentos: é O(n) por fix,
 * mas n é da ordem de milhares e o GPS entrega no máximo um fix por segundo — não
 * compensa a complexidade de uma busca incremental que erraria em rota com laço
 * (o mesmo trecho percorrido duas vezes em sentidos opostos).
 */
export function progressAlongPath(path: RoutePath, pos: LatLng): PathProgress {
  const { points, suffix } = path;
  if (points.length === 0) return { index: 0, offRouteMeters: 0, remainingMeters: 0 };
  if (points.length === 1) {
    return { index: 0, offRouteMeters: haversineMeters(pos, points[0]), remainingMeters: 0 };
  }

  let bestIndex = 0;
  let bestOff = Number.POSITIVE_INFINITY;
  let bestProjection = points[0];
  for (let i = 0; i < points.length - 1; i += 1) {
    const projection = projectOnSegment(pos, points[i], points[i + 1]);
    const off = haversineMeters(pos, projection);
    if (off < bestOff) {
      bestOff = off;
      bestIndex = i;
      bestProjection = projection;
    }
  }
  return {
    index: bestIndex,
    offRouteMeters: bestOff,
    // Do ponto projetado até o próximo vértice, mais tudo que vem depois dele.
    remainingMeters: haversineMeters(bestProjection, points[bestIndex + 1]) + suffix[bestIndex + 1],
  };
}
