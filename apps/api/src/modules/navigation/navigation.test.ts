import { describe, expect, it } from 'vitest';
import { RouteManeuver } from '@cerberus/shared';
import {
  describeManeuver,
  formatDistance,
  formatDuration,
  spokenInstruction,
} from './instructions.js';
import { parseOsrmRoute, straightLineRoute, toManeuver } from './provider.js';
import { distanceToPath, evaluateProgress } from './progress.js';

/** Unidades puras da navegação (issue #131) — sem rede, sem banco. */

describe('instruções em pt-BR', () => {
  it('compõe a manobra com o nome da via', () => {
    expect(
      describeManeuver({ maneuver: RouteManeuver.TURN_RIGHT, streetName: 'Rua dos Aimorés' }),
    ).toBe('Vire à direita na Rua dos Aimorés');
    expect(
      describeManeuver({ maneuver: RouteManeuver.STRAIGHT, streetName: 'Avenida Afonso Pena' }),
    ).toBe('Siga em frente pela Avenida Afonso Pena');
  });

  it('sem nome de via, cai na frase seca (não inventa logradouro)', () => {
    expect(describeManeuver({ maneuver: RouteManeuver.TURN_LEFT })).toBe('Vire à esquerda');
    // "Siga" sozinho não diria nada ao agente.
    expect(describeManeuver({ maneuver: RouteManeuver.DEPART })).toBe('Siga em frente');
  });

  it('rotatória usa ordinal feminino e a saída', () => {
    expect(describeManeuver({ maneuver: RouteManeuver.ROUNDABOUT, roundaboutExit: 2 })).toBe(
      'Na rotatória, pegue a segunda saída',
    );
    expect(
      describeManeuver({
        maneuver: RouteManeuver.ROUNDABOUT,
        roundaboutExit: 1,
        streetName: 'Rua Bahia',
      }),
    ).toBe('Na rotatória, pegue a primeira saída para a Rua Bahia');
  });

  it('chegada ignora o nome da via', () => {
    expect(describeManeuver({ maneuver: RouteManeuver.ARRIVE, streetName: 'Rua X' })).toBe(
      'Você chegou ao destino',
    );
  });

  it('formata distância com vírgula decimal (pt-BR)', () => {
    expect(formatDistance(12)).toBe('12 m');
    expect(formatDistance(187)).toBe('190 m');
    expect(formatDistance(1234)).toBe('1,2 km');
    expect(formatDistance(15400)).toBe('15 km');
  });

  it('formata duração legível', () => {
    expect(formatDuration(30)).toBe('1 min'); // segundos são ruído numa rota veicular
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(4800)).toBe('1 h 20 min');
    expect(formatDuration(7200)).toBe('2 h');
  });

  it('locução antecipa a manobra, mas não quando já está em cima dela', () => {
    expect(spokenInstruction('Vire à direita na Rua X', 200)).toBe(
      'Em 200 m, vire à direita na Rua X',
    );
    expect(spokenInstruction('Vire à direita na Rua X', 10)).toBe('Vire à direita na Rua X');
  });
});

describe('tradução de manobras do OSRM', () => {
  it('mapeia tipos próprios do provedor', () => {
    expect(toManeuver('depart')).toBe(RouteManeuver.DEPART);
    expect(toManeuver('arrive')).toBe(RouteManeuver.ARRIVE);
    expect(toManeuver('rotary')).toBe(RouteManeuver.ROUNDABOUT);
    expect(toManeuver('off ramp')).toBe(RouteManeuver.RAMP);
    expect(toManeuver('fork', 'slight left')).toBe(RouteManeuver.FORK_LEFT);
  });

  it('para "turn"/"continue" quem manda é o modificador', () => {
    expect(toManeuver('turn', 'sharp right')).toBe(RouteManeuver.SHARP_RIGHT);
    expect(toManeuver('turn', 'uturn')).toBe(RouteManeuver.UTURN);
    expect(toManeuver('continue', 'straight')).toBe(RouteManeuver.STRAIGHT);
    expect(toManeuver('end of road', 'left')).toBe(RouteManeuver.TURN_LEFT);
  });

  it('desconhecido degrada para seguir em frente (nunca lança)', () => {
    expect(toManeuver('coisa-nova-do-provedor', 'sei-la')).toBe(RouteManeuver.STRAIGHT);
    expect(toManeuver()).toBe(RouteManeuver.STRAIGHT);
  });
});

describe('parsing da resposta do OSRM', () => {
  const body = {
    code: 'Ok',
    routes: [
      {
        distance: 1520.4,
        duration: 240.7,
        geometry: {
          coordinates: [
            [-43.9386, -19.9319],
            [-43.94, -19.933],
            [-43.941, -19.934],
          ] as [number, number][],
        },
        legs: [
          {
            steps: [
              {
                distance: 800,
                duration: 120,
                name: 'Avenida Afonso Pena',
                maneuver: {
                  type: 'depart',
                  location: [-43.9386, -19.9319] as [number, number],
                },
              },
              {
                distance: 720,
                duration: 120,
                name: 'Rua Bahia',
                maneuver: {
                  type: 'turn',
                  modifier: 'right',
                  location: [-43.94, -19.933] as [number, number],
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it('extrai geometria, passos com instrução pt-BR e totais arredondados', () => {
    const route = parseOsrmRoute(body);
    expect(route).not.toBeNull();
    expect(route!.geometry).toHaveLength(3);
    expect(route!.distanceMeters).toBe(1520);
    expect(route!.durationSec).toBe(241);
    expect(route!.fallback).toBe(false);
    expect(route!.steps.map((s) => s.instruction)).toEqual([
      'Siga pela Avenida Afonso Pena',
      'Vire à direita na Rua Bahia',
    ]);
  });

  it('via sem nome não vira nome de via', () => {
    const route = parseOsrmRoute({
      ...body,
      routes: [
        {
          ...body.routes[0]!,
          legs: [
            {
              steps: [
                {
                  distance: 10,
                  duration: 2,
                  name: '   ', // OSRM devolve vazio/branco em viela e acesso
                  maneuver: { type: 'turn', modifier: 'left', location: [-43.9, -19.9] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(route!.steps[0]!.streetName).toBeUndefined();
    expect(route!.steps[0]!.instruction).toBe('Vire à esquerda');
  });

  it('rejeita resposta sem rota ou com código de erro', () => {
    expect(parseOsrmRoute({ code: 'NoRoute' })).toBeNull();
    expect(parseOsrmRoute({ code: 'Ok', routes: [] })).toBeNull();
    // Geometria com um único ponto não é trajeto.
    expect(
      parseOsrmRoute({
        code: 'Ok',
        routes: [{ geometry: { coordinates: [[-43.9, -19.9]] } }],
      }),
    ).toBeNull();
  });
});

describe('fallback em linha reta', () => {
  it('marca fallback e devolve partida + chegada', () => {
    const route = straightLineRoute({ lng: -43.9386, lat: -19.9319 }, { lng: -43.94, lat: -19.94 });
    expect(route.fallback).toBe(true);
    expect(route.geometry).toHaveLength(2);
    expect(route.steps.map((s) => s.maneuver)).toEqual([
      RouteManeuver.DEPART,
      RouteManeuver.ARRIVE,
    ]);
    // ~900 m entre os dois pontos; o ETA sai de uma velocidade média assumida.
    expect(route.distanceMeters).toBeGreaterThan(500);
    expect(route.durationSec).toBeGreaterThan(0);
  });
});

describe('progresso sobre a rota', () => {
  // Trecho reto ao longo do paralelo -19.93, ~1 km de extensão.
  const path: [number, number][] = [
    [-43.94, -19.93],
    [-43.93, -19.93],
  ];

  it('ponto sobre o traçado tem distância ~zero', () => {
    expect(distanceToPath({ lng: -43.935, lat: -19.93 }, path)).toBeLessThan(1);
  });

  it('mede o afastamento perpendicular em metros', () => {
    // 0,001° de latitude ≈ 110 m.
    const d = distanceToPath({ lng: -43.935, lat: -19.931 }, path);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it('além das pontas mede até o vértice, não até a reta infinita', () => {
    const d = distanceToPath({ lng: -43.95, lat: -19.93 }, path);
    expect(d).toBeGreaterThan(1000); // ~1,05 km a oeste do primeiro vértice
  });

  it('sinaliza desvio quando passa do limiar', () => {
    const dest = { lng: -43.93, lat: -19.93 };
    const onRoute = evaluateProgress({ lng: -43.935, lat: -19.93 }, path, dest);
    expect(onRoute.deviated).toBe(false);

    const offRoute = evaluateProgress({ lng: -43.935, lat: -19.931 }, path, dest);
    expect(offRoute.deviated).toBe(true);
    expect(offRoute.offRouteMeters).toBeGreaterThan(50);
  });

  it('chegada tem precedência sobre desvio', () => {
    const dest = { lng: -43.93, lat: -19.93 };
    // Em cima do destino, mas fora do traçado: é sucesso, não desvio a recalcular.
    const p = evaluateProgress({ lng: -43.93, lat: -19.9301 }, path, dest, {
      deviationMeters: 1,
    });
    expect(p.arrived).toBe(true);
    expect(p.deviated).toBe(false);
  });
});
