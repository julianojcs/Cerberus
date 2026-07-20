import { RouteManeuver, type RouteStep } from '@cerberus/shared';
import { haversineMeters, type GeoPoint } from '../geofences/detect.js';
import { describeManeuver } from './instructions.js';

/**
 * Motor de rotas (issue #131) atrás de uma interface.
 *
 * O OSRM público é o adaptador de DESENVOLVIMENTO — ele não tem SLA e o uso pesado é
 * desencorajado. Produção vai para uma API gerenciada (OpenRouteService, GraphHopper,
 * Mapbox Directions ou Stadia/Valhalla), plugada aqui como um segundo adaptador.
 * Auto-hospedar OSRM está FORA de cogitação: ele é distribuído como container e este
 * projeto não usa Docker.
 *
 * O volume justifica a API gerenciada: directions é chamado uma vez por despacho e uma
 * vez por recálculo de desvio — dezenas a poucas centenas de chamadas/dia, server-side.
 */

export interface ComputedRoute {
  /** Traçado `[[lng, lat], …]`. */
  geometry: [number, number][];
  steps: RouteStep[];
  distanceMeters: number;
  durationSec: number;
  /** Traçado é a linha reta origem→destino (provedor indisponível). */
  fallback: boolean;
}

export interface RoutingProvider {
  readonly name: string;
  /** Retorna `null` quando o provedor não conseguiu traçar (o chamador cai no fallback). */
  computeRoute(origin: GeoPoint, destination: GeoPoint): Promise<ComputedRoute | null>;
}

/* ------------------------------------------------------------ Adaptador OSRM */

/** Resposta do OSRM que efetivamente consumimos (o resto do corpo é ignorado). */
interface OsrmResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: [number, number][] };
    legs?: {
      steps?: {
        distance?: number;
        duration?: number;
        name?: string;
        maneuver?: {
          type?: string;
          modifier?: string;
          exit?: number;
          location?: [number, number];
        };
      }[];
    }[];
  }[];
}

/**
 * Traduz o par `(type, modifier)` do OSRM para o NOSSO vocabulário de manobra. Essa
 * tradução é a fronteira que impede o vocabulário do provedor de vazar para o app e
 * para as instruções em pt-BR — trocar de provedor é reescrever só esta função.
 */
export function toManeuver(type?: string, modifier?: string): RouteManeuver {
  switch (type) {
    case 'depart':
      return RouteManeuver.DEPART;
    case 'arrive':
      return RouteManeuver.ARRIVE;
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return RouteManeuver.ROUNDABOUT;
    case 'merge':
      return RouteManeuver.MERGE;
    case 'ramp':
    case 'on ramp':
    case 'off ramp':
      return RouteManeuver.RAMP;
    case 'fork':
      return modifier?.includes('left') ? RouteManeuver.FORK_LEFT : RouteManeuver.FORK_RIGHT;
    default:
      break;
  }
  // 'turn', 'end of road', 'continue', 'new name'… — quem manda é o modificador.
  switch (modifier) {
    case 'uturn':
      return RouteManeuver.UTURN;
    case 'sharp left':
      return RouteManeuver.SHARP_LEFT;
    case 'sharp right':
      return RouteManeuver.SHARP_RIGHT;
    case 'slight left':
      return RouteManeuver.SLIGHT_LEFT;
    case 'slight right':
      return RouteManeuver.SLIGHT_RIGHT;
    case 'left':
      return RouteManeuver.TURN_LEFT;
    case 'right':
      return RouteManeuver.TURN_RIGHT;
    default:
      return RouteManeuver.STRAIGHT;
  }
}

/** Converte a resposta do OSRM em `ComputedRoute`. Exportada para os testes. */
export function parseOsrmRoute(body: OsrmResponse): ComputedRoute | null {
  if (body.code !== 'Ok') return null;
  const route = body.routes?.[0];
  const geometry = route?.geometry?.coordinates;
  if (!geometry || geometry.length < 2) return null;

  const steps: RouteStep[] = [];
  for (const leg of route?.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const maneuver = toManeuver(s.maneuver?.type, s.maneuver?.modifier);
      // `name` vem string vazia quando a via não tem nome (viela, acesso) — não é via.
      const streetName = s.name && s.name.trim().length > 0 ? s.name : undefined;
      steps.push({
        instruction: describeManeuver({
          maneuver,
          streetName,
          roundaboutExit: s.maneuver?.exit,
        }),
        maneuver,
        streetName,
        distanceMeters: Math.round(s.distance ?? 0),
        durationSec: Math.round(s.duration ?? 0),
        location: s.maneuver?.location ?? geometry[0]!,
      });
    }
  }

  return {
    geometry,
    steps,
    distanceMeters: Math.round(route?.distance ?? 0),
    durationSec: Math.round(route?.duration ?? 0),
    fallback: false,
  };
}

/**
 * Adaptador do OSRM. Perfil fixo em `driving` — decisão de produto da issue #131
 * (rota a pé fora de escopo, bicicleta nunca). Isso é o que permite usar o servidor
 * público: ele só serve `driving` de forma confiável.
 */
export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = 'osrm';

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async computeRoute(origin: GeoPoint, destination: GeoPoint): Promise<ComputedRoute | null> {
    const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    const url =
      `${this.baseUrl}/route/v1/driving/${coords}` +
      `?geometries=geojson&overview=full&steps=true&annotations=false`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      return parseOsrmRoute((await res.json()) as OsrmResponse);
    } catch {
      // Sem rede, timeout ou OSRM fora — o chamador desenha a linha reta.
      return null;
    }
  }
}

/* ---------------------------------------------------------------- Fallback */

/**
 * Velocidade média (m/s) para estimar o ETA da linha reta — 30 km/h, compatível com
 * deslocamento urbano. É uma estimativa grosseira de propósito: a rota de fallback
 * não conhece a malha viária, então prometer precisão seria mentira.
 */
const FALLBACK_SPEED_MS = 30_000 / 3600;

/**
 * Linha reta origem→destino, usada quando o provedor está indisponível. Marca
 * `fallback: true` para o app mostrar rumo/distância em vez de fingir que tem
 * instruções de via — melhor degradar honestamente do que navegar por um traçado
 * que ignora as ruas.
 */
export function straightLineRoute(origin: GeoPoint, destination: GeoPoint): ComputedRoute {
  const distanceMeters = Math.round(haversineMeters(origin, destination));
  const durationSec = Math.round(distanceMeters / FALLBACK_SPEED_MS);
  return {
    geometry: [
      [origin.lng, origin.lat],
      [destination.lng, destination.lat],
    ],
    steps: [
      {
        instruction: 'Siga em direção ao destino (traçado direto, sem dados de via)',
        maneuver: RouteManeuver.DEPART,
        distanceMeters,
        durationSec,
        location: [origin.lng, origin.lat],
      },
      {
        instruction: 'Você chegou ao destino',
        maneuver: RouteManeuver.ARRIVE,
        distanceMeters: 0,
        durationSec: 0,
        location: [destination.lng, destination.lat],
      },
    ],
    distanceMeters,
    durationSec,
    fallback: true,
  };
}

/**
 * Traça a rota pelo provedor e, se ele falhar, devolve a linha reta. Nunca lança:
 * despachar uma rota degradada é melhor do que deixar o operador sem nada quando o
 * agente já está esperando ordem de deslocamento.
 */
export async function computeRouteWithFallback(
  provider: RoutingProvider,
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<ComputedRoute> {
  const computed = await provider.computeRoute(origin, destination);
  return computed ?? straightLineRoute(origin, destination);
}
