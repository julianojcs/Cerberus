/**
 * SIMULADOR DE AGENTES — telemetria realista no barramento, sem celular.
 *
 * Existe porque testar o dashboard exigia um aparelho com o app de campo rodando:
 * Metro vivo na máquina, cabo, bateria, GPS preso dentro do prédio. O dashboard, no
 * entanto, não sabe o que é um celular — ele assina `operacao/{opId}/#` e desenha o
 * que chega. Basta publicar telemetria VÁLIDA no barramento.
 *
 * Diferença para o antigo `scripts/publish-fake-position.mjs`: aqui as posições seguem
 * RUAS de verdade (roteamento OSRM sobre OpenStreetMap) e o `heading` é derivado do
 * trajeto real. O script antigo derivava o marcador em círculo (`lat += sin(step/8)`)
 * com heading sintético (`step * 15 % 360`) — trilha falsa não exercita a seta de
 * direção nem a segmentação por gaps.
 *
 * Uso:
 *   npm run api:sim:setup                     # ANTES: cadastra operação + agentes + equipes
 *   npm run api:sim -- --op <id> --roster     # simula as EQUIPES cadastradas (recomendado)
 *   npm run api:sim -- --op <id> --agents 3 --speed 40 --profile driving
 *   npm run api:sim -- --op <id> --agent AG-0456 --route "-19.9319,-43.9386;-19.9245,-43.9352"
 *   npm run api:sim -- --op <id> --roster --gap 30   # some 30 s a cada volta (testa segmentação)
 *   npm run api:sim -- --op <id> --roster --idle     # parado: só heartbeat, sem deslocamento
 *
 * BROKER: prefere `SIM_MQTT_*` (aponta para o HiveMQ, para o dashboard/ponte da nuvem
 * verem os agentes); se ausente, cai em `MQTT_*` e por fim `mqtt://localhost:1883`.
 * No modo `--roster`, os agentes/equipes vêm de `sim-roster.ts` (mesma fonte do setup).
 */
import mqtt, { type MqttClient } from 'mqtt';
import {
  ActivityType,
  agentPositionTopic,
  agentStatusTopic,
  type AgentStatus,
  type PositionSample,
} from '@cerberus/shared';
import { SIM_TEAMS, teamOf } from './sim-roster.js';

/** Metros entre agentes da mesma equipe ao longo do traçado (coluna de patrulha). */
const TEAM_STAGGER_M = 45;

/** Ponto no formato GeoJSON/OSRM `[longitude, latitude]` (ver regra geospatial-coordinates). */
type LngLat = [number, number];

// --- Roteiros padrão (Belo Horizonte / MG) -----------------------------------------
// Circuitos distintos para que múltiplos agentes não andem empilhados no mesmo traço.
// Coordenadas em [lng, lat] — a ordem do GeoJSON, transposta só na publicação.
const DEFAULT_CIRCUITS: LngLat[][] = [
  // Centro: Praça Sete → Mercado Central → Parque Municipal
  [
    [-43.9386, -19.9208],
    [-43.9407, -19.9186],
    [-43.9333, -19.9227],
  ],
  // Savassi → Praça da Liberdade → Praça do Papa
  [
    [-43.9337, -19.9386],
    [-43.9386, -19.9319],
    [-43.921, -19.9455],
  ],
  // Pampulha: Mineirão → Igrejinha
  [
    [-43.9708, -19.8659],
    [-43.9797, -19.8516],
    [-43.9615, -19.8563],
  ],
];

const R_EARTH = 6371000; // metros
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Distância em metros entre dois pontos (haversine). */
function haversine([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/**
 * Azimute (0–360°) de `a` para `b`. É a fonte do `heading`: a seta do agente precisa
 * apontar para onde ele está REALMENTE indo — heading inventado não testa nada.
 */
function bearing([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpola entre dois pontos (t ∈ [0,1]). Em escala urbana o erro planar é irrelevante. */
function lerp([lng1, lat1]: LngLat, [lng2, lat2]: LngLat, t: number): LngLat {
  return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
}

/** Fecha o circuito voltando ao ponto inicial — o agente circula sem teleportar no fim. */
function closeCircuit(pts: LngLat[]): LngLat[] {
  const first = pts[0];
  return first ? [...pts, first] : pts;
}

/** Polilinha com distâncias acumuladas — permite "andar" N metros pelo traçado. */
interface Path {
  points: LngLat[];
  /** `cum[i]` = distância do início até `points[i]`. */
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

/** Posição + rumo a `dist` metros do início do traçado (dá a volta ao passar do fim). */
function locate(path: Path, dist: number): { at: LngLat; heading: number } {
  const first = path.points[0] ?? ([0, 0] as LngLat);
  if (path.total <= 0) return { at: first, heading: 0 };

  const d = ((dist % path.total) + path.total) % path.total; // circuito fechado
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

/**
 * Encaixa os waypoints nas ruas via OSRM (OpenStreetMap). O servidor público de
 * demonstração só serve o perfil `driving` de forma confiável — para `foot`/`bike`
 * aponte `--osrm` para uma instância própria (roda em Docker, encaixa no infra:up).
 * Na prática, para cenário tático urbano a malha viária é a mesma; o que muda é a
 * VELOCIDADE, e essa vem de `--speed`.
 */
async function routeOnStreets(
  waypoints: LngLat[],
  profile: string,
  osrmBase: string,
): Promise<LngLat[] | null> {
  const coords = closeCircuit(waypoints)
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(';');
  const url = `${osrmBase}/route/v1/${profile}/${coords}?geometries=geojson&overview=full`;
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
    return null; // sem internet / OSRM fora — o chamador cai no fallback reto
  }
}

// --- CLI ---------------------------------------------------------------------------
interface Options {
  operationId: string;
  agentIds: string[];
  roster: boolean;
  speedKmh: number;
  intervalSec: number;
  profile: string;
  osrmBase: string;
  waypoints: LngLat[] | null;
  gapSec: number;
  idle: boolean;
}

/** Plano de um agente: id, região a patrulhar e offset inicial no traçado (escalonamento). */
interface AgentPlan {
  agentId: string;
  waypoints: LngLat[];
  startOffsetM: number;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);

  const operationId = get('--op') ?? process.env.OPERATION_ID ?? '';
  const agentCount = Number(get('--agents') ?? 1);
  const single = get('--agent');
  const agentIds = single
    ? [single]
    : Array.from({ length: agentCount }, (_, i) => `AG-${String(i + 1).padStart(4, '0')}`);

  // `--route "lat,lng;lat,lng"` — na CLI o operador digita lat,lng (convenção humana/GPS);
  // internamente vira [lng,lat] (GeoJSON). Ver .claude/rules/geospatial-coordinates.md.
  const routeRaw = get('--route');
  const waypoints = routeRaw
    ? routeRaw.split(';').map((pair): LngLat => {
        const [lat = 0, lng = 0] = pair.split(',').map(Number);
        return [lng, lat];
      })
    : null;

  const profile = get('--profile') ?? 'driving';
  return {
    operationId,
    agentIds,
    roster: has('--roster'),
    speedKmh: Number(get('--speed') ?? (profile === 'driving' ? 40 : 5)),
    intervalSec: Number(get('--interval') ?? 2),
    profile,
    osrmBase: get('--osrm') ?? process.env.OSRM_URL ?? 'https://router.project-osrm.org',
    waypoints,
    gapSec: Number(get('--gap') ?? 0),
    idle: has('--idle'),
  };
}

/** Broker do simulador: prefere HiveMQ (SIM_MQTT_*), cai em MQTT_*, por fim localhost. */
function brokerConfig(): { url: string; username?: string; password?: string } {
  return {
    url: process.env.SIM_MQTT_BROKER_URL ?? process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
    username: process.env.SIM_MQTT_USERNAME || process.env.MQTT_USERNAME || undefined,
    password: process.env.SIM_MQTT_PASSWORD || process.env.MQTT_PASSWORD || undefined,
  };
}

/** Só o host do broker, para logar sem vazar credenciais embutidas na URL. */
function brokerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Monta os planos por agente. No modo `--roster`, usa as EQUIPES cadastradas: cada
 * equipe patrulha seu circuito e os agentes saem escalonados (coluna) — as equipes
 * ficam separadas no mapa. Fora do roster, mantém o comportamento genérico.
 */
function buildPlans(opts: Options): AgentPlan[] {
  if (opts.roster) {
    return SIM_TEAMS.flatMap((team) =>
      team.agents.map((agentId, i) => ({
        agentId,
        waypoints: team.circuit,
        startOffsetM: i * TEAM_STAGGER_M,
      })),
    );
  }
  return opts.agentIds.map((agentId, index) => ({
    agentId,
    waypoints:
      opts.waypoints ?? DEFAULT_CIRCUITS[index % DEFAULT_CIRCUITS.length] ?? DEFAULT_CIRCUITS[0] ?? [],
    startOffsetM: 0,
  }));
}

/** Atividade coerente com o perfil/velocidade — o painel usa isto como rótulo. */
function activityFor(opts: Options, moving: boolean): ActivityType {
  if (!moving) return ActivityType.STILL;
  if (opts.profile === 'driving') return ActivityType.IN_VEHICLE;
  if (opts.speedKmh > 9) return ActivityType.RUNNING;
  return ActivityType.WALKING;
}

/** Um agente simulado: seu próprio cliente MQTT (clientId estável) e sua própria rota. */
async function startAgent(opts: Options, plan: AgentPlan): Promise<() => void> {
  const { agentId, waypoints } = plan;
  const team = teamOf(agentId);
  const tag = team ? `${agentId}/${team.name.replace('Equipe ', '')}` : agentId;

  let geometry = await routeOnStreets(waypoints, opts.profile, opts.osrmBase);
  if (!geometry) {
    console.warn(
      `[${tag}] OSRM indisponível em ${opts.osrmBase} — caindo para linhas retas entre os waypoints (a trilha NÃO seguirá ruas).`,
    );
    geometry = closeCircuit(waypoints);
  } else {
    console.log(`[${tag}] rota encaixada nas ruas: ${geometry.length} vértices.`);
  }
  const path = buildPath(geometry);

  const positionTopic = agentPositionTopic(opts.operationId, agentId);
  const statusTopic = agentStatusTopic(opts.operationId, agentId);
  const offline = JSON.stringify({ online: false } satisfies AgentStatus);

  const broker = brokerConfig();
  const client: MqttClient = mqtt.connect(broker.url, {
    // clientId ESTÁVEL, igual ao app real: garante o takeover da sessão zumbi e a
    // ordem correta do testamento na reconexão (ver ADR-0004).
    clientId: `agente_${agentId}`,
    username: broker.username,
    password: broker.password,
    reconnectPeriod: 3000,
    clean: true,
    // Mesmo testamento do app: um `kill -9` neste processo exercita o caminho de
    // queda suja (o broker anuncia o offline quando o keepalive expira).
    will: { topic: statusTopic, payload: offline, qos: 1, retain: true },
  });

  // Offset inicial: agentes da mesma equipe saem escalonados (coluna de patrulha).
  let travelled = plan.startOffsetM; // metros percorridos no circuito
  let battery = 1; // schema: 0..1 (não 0..100)
  let ticks = 0;
  let timer: NodeJS.Timeout | undefined;

  client.on('error', (err) => console.error(`[${agentId}] MQTT: ${err.message}`));

  client.on('connect', () => {
    // Presença retida: o dashboard sabe o estado assim que assina, sem esperar posição.
    client.publish(statusTopic, JSON.stringify({ online: true } satisfies AgentStatus), {
      qos: 1,
      retain: true,
    });
    console.log(`[${tag}] online (${brokerHost(broker.url)}) → ${positionTopic}`);

    const speedMs = (opts.speedKmh * 1000) / 3600;
    timer = setInterval(() => {
      ticks += 1;

      // Janela de sombra: continua ANDANDO mas para de publicar. É o que gera um gap
      // real na trilha (agente reaparece adiante) — exercita a segmentação do PR #109.
      if (opts.gapSec > 0) {
        const cycle = 20; // amostras de sinal
        const darkTicks = Math.ceil(opts.gapSec / opts.intervalSec);
        if (ticks % (cycle + darkTicks) >= cycle) {
          travelled += speedMs * opts.intervalSec;
          if (ticks % (cycle + darkTicks) === cycle) console.log(`[${agentId}] ⚡ zona de sombra`);
          return;
        }
      }

      const moving = !opts.idle;
      if (moving) travelled += speedMs * opts.intervalSec;
      const { at, heading } = locate(path, travelled);

      // Ruído gaussiano leve no fix (~±4 m) — GPS perfeito não existe e a trilha
      // suave demais esconde bugs de suavização/filtro no painel.
      const jitter = () => (Math.random() + Math.random() - 1) * 0.00004;
      const [lng, lat] = at;

      battery = Math.max(0.05, battery - 0.0002);

      // TRANSPOSIÇÃO: rota é [lng,lat] (GeoJSON); o payload MQTT é {lat,lng}.
      const sample: PositionSample = {
        lat: lat + jitter(),
        lng: lng + jitter(),
        accuracy: 4 + Math.random() * 6,
        altitude: 850 + Math.random() * 30, // BH ~850 m
        speed: moving ? Number(speedMs.toFixed(2)) : 0,
        heading: moving ? Number(heading.toFixed(1)) : null,
        battery: Number(battery.toFixed(3)),
        activity: activityFor(opts, moving),
        capturedAt: new Date().toISOString(), // UTC absoluto (regra timezone-dates)
      };

      client.publish(positionTopic, JSON.stringify(sample), { qos: 1 });
      console.log(
        `[${agentId}] ${sample.lat.toFixed(5)},${sample.lng.toFixed(5)} ` +
          `hdg ${sample.heading ?? '—'}° · ${opts.speedKmh} km/h · bat ${(battery * 100).toFixed(0)}%`,
      );
    }, opts.intervalSec * 1000);
  });

  // Saída LIMPA: anuncia offline e só então encerra — o DISCONNECT limpo faz o broker
  // DESCARTAR o testamento, sem anúncio duplicado (mesmo contrato do app real).
  return () => {
    if (timer) clearInterval(timer);
    if (client.connected) {
      client.publish(statusTopic, offline, { qos: 1, retain: true }, () => client.end(false));
    } else {
      client.end(true);
    }
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.operationId) {
    console.error(
      'Informe a operação: `npm run api:sim -- --op <operationId>` (o id sai de `npm run api:seed`).',
    );
    process.exit(1);
  }

  const plans = buildPlans(opts);
  const broker = brokerConfig();

  console.log(
    `Simulando ${plans.length} agente(s) na operação ${opts.operationId} · ` +
      `broker ${brokerHost(broker.url)} · perfil ${opts.profile} · ${opts.speedKmh} km/h · ` +
      `amostra a cada ${opts.intervalSec}s` +
      `${opts.idle ? ' · PARADO' : ''}${opts.gapSec ? ` · sombra de ${opts.gapSec}s` : ''}`,
  );
  if (opts.roster) {
    for (const t of SIM_TEAMS) console.log(`  Equipe ${t.name} (${t.color}): ${t.agents.join(', ')}`);
  }

  const stops = await Promise.all(plans.map((plan) => startAgent(opts, plan)));

  const shutdown = () => {
    console.log('\nEncerrando: publicando offline dos agentes…');
    for (const stop of stops) stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
