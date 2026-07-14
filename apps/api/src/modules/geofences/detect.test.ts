import { describe, it, expect } from 'vitest';
import { detectGeofenceEvents, haversineMeters } from './detect.js';

const ZONE = [
  { _id: 'g1', name: 'Zona A', center: { coordinates: [-43.9386, -19.9319] }, radiusMeters: 100 },
];

const INSIDE = { lng: -43.9386, lat: -19.9319 }; // centro
const OUTSIDE = { lng: -43.95, lat: -19.94 }; // ~1,5 km do centro

describe('haversineMeters', () => {
  it('mede ~0 no mesmo ponto e distância crescente ao afastar', () => {
    expect(haversineMeters(INSIDE, INSIDE)).toBeLessThan(1);
    expect(haversineMeters(INSIDE, OUTSIDE)).toBeGreaterThan(1000);
  });
});

describe('detectGeofenceEvents (estado de pertencimento)', () => {
  it('enter: estava fora → agora dentro', () => {
    expect(detectGeofenceEvents(INSIDE, { g1: false }, ZONE)).toEqual([
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'enter', inside: true, notify: true, severity: 'medium' },
    ]);
  });

  it('exit: estava dentro → agora fora', () => {
    expect(detectGeofenceEvents(OUTSIDE, { g1: true }, ZONE)).toEqual([
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'exit', inside: false, notify: true, severity: 'medium' },
    ]);
  });

  it('sem transição: dentro e continua dentro NÃO repete enter', () => {
    expect(detectGeofenceEvents(INSIDE, { g1: true }, ZONE)).toEqual([]);
  });

  it('sem transição: fora e continua fora não gera evento', () => {
    expect(detectGeofenceEvents(OUTSIDE, { g1: false }, ZONE)).toEqual([]);
  });

  it('primeira leitura dentro (sem estado) conta como um único enter', () => {
    const events = detectGeofenceEvents(INSIDE, {}, ZONE);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('enter');
  });
});

describe('detectGeofenceEvents — regras avançadas (Fase 5b)', () => {
  it('zona por equipe: agente fora da equipe não gera evento', () => {
    const zone = [{ ...ZONE[0], teamId: 't1' }];
    // Sem equipes do agente → pula a zona (nenhum evento, nem tracking).
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { agentTeamIds: [] })).toEqual([]);
    // Agente da equipe → enter normal.
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { agentTeamIds: ['t1'] })).toHaveLength(
      1,
    );
  });

  it('agendamento: fora da janela horária não gera evento', () => {
    const zone = [{ ...ZONE[0], windowStartMin: 600, windowEndMin: 660 }]; // 10–11h UTC
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { atUtcMin: 480 })).toEqual([]); // 08:00
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { atUtcMin: 630 })).toHaveLength(1); // 10:30
  });

  it('agendamento: janela que cruza a meia-noite (22h–06h)', () => {
    const zone = [{ ...ZONE[0], windowStartMin: 1320, windowEndMin: 360 }]; // 22:00–06:00
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { atUtcMin: 1380 })).toHaveLength(1); // 23:00 ✓
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { atUtcMin: 120 })).toHaveLength(1); // 02:00 ✓
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone, { atUtcMin: 720 })).toEqual([]); // 12:00 ✗
  });

  it('gatilho "enter": a transição de saída atualiza estado mas não notifica', () => {
    const zone = [{ ...ZONE[0], triggerOn: 'enter' }];
    const [enter] = detectGeofenceEvents(INSIDE, { g1: false }, zone);
    expect(enter?.notify).toBe(true);
    const [exit] = detectGeofenceEvents(OUTSIDE, { g1: true }, zone);
    expect(exit?.type).toBe('exit');
    expect(exit?.notify).toBe(false); // pertencimento muda, mas não alerta
  });

  it('severidade da zona é propagada ao evento', () => {
    const zone = [{ ...ZONE[0], severity: 'critical' }];
    expect(detectGeofenceEvents(INSIDE, { g1: false }, zone)[0]?.severity).toBe('critical');
  });
});
