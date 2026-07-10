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

describe('detectGeofenceEvents', () => {
  it('enter: fora → dentro', () => {
    expect(detectGeofenceEvents(INSIDE, OUTSIDE, ZONE)).toEqual([
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'enter' },
    ]);
  });

  it('exit: dentro → fora', () => {
    expect(detectGeofenceEvents(OUTSIDE, INSIDE, ZONE)).toEqual([
      { geofenceId: 'g1', geofenceName: 'Zona A', type: 'exit' },
    ]);
  });

  it('sem transição: dentro → dentro não gera evento', () => {
    expect(detectGeofenceEvents(INSIDE, { lng: -43.9387, lat: -19.932 }, ZONE)).toEqual([]);
  });

  it('sem transição: fora → fora não gera evento', () => {
    expect(detectGeofenceEvents(OUTSIDE, { lng: -43.96, lat: -19.95 }, ZONE)).toEqual([]);
  });

  it('primeira posição (prev null) dentro conta como enter', () => {
    const events = detectGeofenceEvents(INSIDE, null, ZONE);
    expect(events[0]?.type).toBe('enter');
  });
});
