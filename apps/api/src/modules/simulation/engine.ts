/**
 * Motor da simulação hospedada na API (issue #134).
 *
 * É o núcleo reusável do simulador, SEM I/O: encaixa o circuito de cada equipe nas ruas
 * (OSRM), pré-processa o traçado e, a cada passo, produz um `PositionSample` fisicamente
 * coerente (na via, com `heading` real, ruído leve de GPS). Quem publica no barramento é
 * o `service.ts` — aqui só se gera o dado.
 *
 * A geometria é mantida independente do CLI (`scripts/simulate-agents.ts`) de propósito:
 * este é código de produção com ciclo de vida gerenciado; acoplar os dois amarraria a
 * API a um script de desenvolvimento. O `roster` (dados) é que é compartilhado.
 */
import { ActivityType, type PositionSample } from '@cerberus/shared';
import { SIM_TEAMS, teamOf } from './roster.js';

/** Ponto GeoJSON `[longitude, latitude]`. */
type LngLat = [number, number];

/** Metros entre agentes da mesma equipe ao longo do traçado (coluna de patrulha). */
const TEAM_STAGGER_M = 45;
/** Velocidade do deslocamento simulado (km/h) — trânsito urbano. */
export const SIM_SPEED_KMH = 40;
/** Intervalo entre amostras (ms) — equivale a um GPS em navegação. */
export const SIM_INTERVAL_MS = 2000;

const R_EARTH = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function haversine([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** Azimute (0–360°) de `a` para `b` — a fonte do `heading` (aponta para onde vai). */
function bearing([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function lerp([lng1, lat1]: LngLat, [lng2, lat2]: LngLat, t: number): LngLat {
  return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
}

function closeCircuit(pts: LngLat[]): LngLat[] {
  const first = pts[0];
  return first ? [...pts, first] : pts;
}

interface Path {
  points: LngLat[];
  cum: number[];
  total: number;
}

function buildPath(points: LngLat[]): Path {
  const cum: number[] = [0];
  let total = 0;
  let prev = points[0];
  if (!prev) return { points, cum, total: 0 };
  for (const curr of points.slice(1)) {
    total += haversine(prev, curr);
    cum.push(total);
    prev = curr;
  }
  return { points, cum, total };
}

/** Posição + rumo a `dist` metros do início; o circuito de patrulha dá a volta. */
function locate(path: Path, dist: number): { at: LngLat; heading: number } {
  const first = path.points[0] ?? ([0, 0] as LngLat);
  if (path.total <= 0) return { at: first, heading: 0 };

  const d = ((dist % path.total) + path.total) % path.total;
  let i = 1;
  while (i < path.cum.length - 1 && (path.cum[i] ?? 0) < d) i++;

  const segStart = path.points[i - 1];
  const segEnd = path.points[i];
  const startDist = path.cum[i - 1];
  const endDist = path.cum[i];
  if (!segStart || !segEnd || startDist === undefined || endDist === undefined) {
    return { at: first, heading: 0 };
  }
  const segLen = endDist - startDist;
  const t = segLen > 0 ? (d - startDist) / segLen : 0;
  return { at: lerp(segStart, segEnd, t), heading: bearing(segStart, segEnd) };
}

/** Encaixa o circuito nas ruas (OSRM). Falha ⇒ null, o chamador cai em linha reta. */
async function routeOnStreets(waypoints: LngLat[], osrmBase: string): Promise<LngLat[] | null> {
  const coords = closeCircuit(waypoints)
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(';');
  const url = `${osrmBase}/route/v1/driving/${coords}?geometries=geojson&overview=full`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      code?: string;
      routes?: { geometry?: { coordinates?: LngLat[] } }[];
    };
    if (body.code !== 'Ok') return null;
    const geometry = body.routes?.[0]?.geometry?.coordinates;
    return geometry && geometry.length > 1 ? geometry : null;
  } catch {
    return null;
  }
}

/** Estado por agente durante uma simulação. `path`/`offset` são fixos; o resto avança. */
export interface AgentRun {
  agentId: string;
  teamName: string;
  path: Path;
  travelled: number;
  battery: number;
}

/**
 * Monta o estado de todos os agentes do roster: roteia o circuito de cada equipe nas
 * ruas e escalona os agentes em coluna. `false` só no caso improvável de um circuito
 * degenerar (sem geometria) — aí cai na linha reta entre os waypoints.
 */
export async function buildAgentRuns(osrmBase: string): Promise<AgentRun[]> {
  const runs: AgentRun[] = [];
  for (const team of SIM_TEAMS) {
    const geometry = (await routeOnStreets(team.circuit, osrmBase)) ?? closeCircuit(team.circuit);
    const path = buildPath(geometry);
    team.agents.forEach((agentId, i) => {
      runs.push({
        agentId,
        teamName: team.name,
        path,
        travelled: i * TEAM_STAGGER_M, // coluna de patrulha
        battery: 1,
      });
    });
  }
  return runs;
}

/** Avança o agente um passo e devolve a amostra a publicar (muta `run`). */
export function stepAgent(run: AgentRun): PositionSample {
  const stepMeters = (((SIM_SPEED_KMH * 1000) / 3600) * SIM_INTERVAL_MS) / 1000;
  run.travelled += stepMeters;
  run.battery = Math.max(0.05, run.battery - 0.0002);
  const { at, heading } = locate(run.path, run.travelled);

  // Ruído gaussiano leve (~±4 m): GPS perfeito não existe, e trilha lisa demais esconde
  // bugs de suavização no painel.
  const jitter = () => (Math.random() + Math.random() - 1) * 0.00004;
  return {
    lat: at[1] + jitter(),
    lng: at[0] + jitter(),
    accuracy: 4 + Math.random() * 6,
    altitude: 850 + Math.random() * 30, // BH ~850 m
    speed: Number(((SIM_SPEED_KMH * 1000) / 3600).toFixed(2)),
    heading: Number(heading.toFixed(1)),
    battery: Number(run.battery.toFixed(3)),
    activity: ActivityType.IN_VEHICLE,
    capturedAt: new Date().toISOString(), // UTC absoluto (regra timezone-dates)
  };
}

/** Rótulo curto do agente para logs (`AG-SIM-01/Alfa`). */
export function agentTag(agentId: string): string {
  const team = teamOf(agentId);
  return team ? `${agentId}/${team.name.replace('Equipe ', '')}` : agentId;
}
