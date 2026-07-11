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
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'enter', inside: true },
    ]);
  });

  it('exit: estava dentro → agora fora', () => {
    expect(detectGeofenceEvents(OUTSIDE, { g1: true }, ZONE)).toEqual([
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'exit', inside: false },
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
