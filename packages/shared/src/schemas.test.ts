import { describe, expect, it } from 'vitest';
import { authClaimsSchema, geoPointSchema, positionSampleSchema } from './schemas.js';

describe('positionSampleSchema', () => {
  const valid = {
    lat: -19.9319,
    lng: -43.9386,
    accuracy: 8,
    speed: 4.2,
    heading: 90,
    battery: 0.87,
    activity: 'in_vehicle',
    capturedAt: '2026-07-10T01:40:25.418Z',
  };

  it('aceita uma amostra de telemetria válida', () => {
    expect(positionSampleSchema.parse(valid)).toMatchObject({ lat: -19.9319, lng: -43.9386 });
  });

  it('rejeita latitude fora do intervalo', () => {
    expect(positionSampleSchema.safeParse({ ...valid, lat: 120 }).success).toBe(false);
  });

  it('rejeita capturedAt que não seja ISO 8601', () => {
    expect(positionSampleSchema.safeParse({ ...valid, capturedAt: '10/07/2026' }).success).toBe(
      false,
    );
  });

  it('aceita speed/heading nulos (sensor sem leitura)', () => {
    expect(positionSampleSchema.safeParse({ ...valid, speed: null, heading: null }).success).toBe(
      true,
    );
  });
});

describe('geoPointSchema', () => {
  it('exige a ordem GeoJSON [lng, lat]', () => {
    expect(
      geoPointSchema.parse({ type: 'Point', coordinates: [-43.9, -19.9] }).coordinates,
    ).toEqual([-43.9, -19.9]);
  });

  it('rejeita longitude inválida', () => {
    expect(geoPointSchema.safeParse({ type: 'Point', coordinates: [200, -19.9] }).success).toBe(
      false,
    );
  });
});

describe('authClaimsSchema', () => {
  it('assume operationIds vazio por padrão', () => {
    const claims = authClaimsSchema.parse({ sub: 'u1', role: 'agente' });
    expect(claims.operationIds).toEqual([]);
  });

  it('rejeita papel desconhecido', () => {
    expect(authClaimsSchema.safeParse({ sub: 'u1', role: 'root' }).success).toBe(false);
  });
});
