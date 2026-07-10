'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MlMap, type Marker, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface AgentPoint {
  agentId: string;
  lat: number;
  lng: number;
  heading?: number | null;
  battery?: number;
  activity?: string;
}

/** Trilha por agente, em ordem cronológica, no formato [lng, lat] do MapLibre. */
export type AgentTrails = Record<string, [number, number][]>;

function toFeatureCollection(trails: AgentTrails): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: Object.entries(trails)
      .filter(([, points]) => points.length >= 2)
      .map(([agentId, points]) => ({
        type: 'Feature',
        properties: { agentId },
        geometry: { type: 'LineString', coordinates: points },
      })),
  };
}

function syncTrails(map: MlMap, trails: AgentTrails): void {
  const source = map.getSource('trails') as GeoJSONSource | undefined;
  source?.setData(toFeatureCollection(trails));
}

/**
 * Mapa de plotagem em tempo real. Recebe as posições correntes de cada agente
 * (mapa agentId -> ponto) e a trilha acumulada (agentId -> pontos), atualizando
 * marcadores e a linha de percurso. Usa MapLibre GL com tiles OSM (sem chave de
 * API), adequado ao MVP custo-zero.
 */
export function LiveMap({
  agents,
  trails = {},
  showTrails = true,
}: {
  agents: Record<string, AgentPoint>;
  trails?: AgentTrails;
  showTrails?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const fittedRef = useRef(false);
  const styleReadyRef = useRef(false);
  // Mantém a trilha/visibilidade correntes acessíveis ao handler de 'load'
  // (evita closure obsoleto na inicialização assíncrona do estilo).
  const trailsRef = useRef<AgentTrails>(trails);
  trailsRef.current = trails;
  const showTrailsRef = useRef(showTrails);
  showTrailsRef.current = showTrails;

  // Inicializa o mapa uma única vez.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [-43.9386, -19.9319], // Belo Horizonte
      zoom: 12,
    });
    mapRef.current = map;

    // A camada de trilha só pode ser adicionada após o estilo carregar.
    map.on('load', () => {
      map.addSource('trails', { type: 'geojson', data: toFeatureCollection(trailsRef.current) });
      map.addLayer({
        id: 'trails-line',
        type: 'line',
        source: 'trails',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
          visibility: showTrailsRef.current ? 'visible' : 'none',
        },
        paint: { 'line-color': '#c1121f', 'line-width': 3, 'line-opacity': 0.65 },
      });
      styleReadyRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, []);

  // Sincroniza marcadores com o estado de agentes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const [agentId, point] of Object.entries(agents)) {
      let marker = markersRef.current[agentId];
      if (!marker) {
        const el = document.createElement('div');
        el.title = agentId;
        el.style.cssText =
          'width:18px;height:18px;border-radius:50%;background:#c1121f;border:2px solid #fff;box-shadow:0 0 8px #c1121f;';
        marker = new maplibregl.Marker({ element: el })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        marker.setPopup(new maplibregl.Popup({ offset: 12 }));
        markersRef.current[agentId] = marker;
      }
      marker.setLngLat([point.lng, point.lat]);
      marker
        .getPopup()
        ?.setHTML(
          `<strong>${agentId}</strong><br/>bat: ${
            point.battery != null ? Math.round(point.battery * 100) + '%' : '—'
          }<br/>${point.activity ?? ''}`,
        );
    }

    // Enquadra a primeira posição recebida.
    const first = Object.values(agents)[0];
    if (first && !fittedRef.current) {
      map.easeTo({ center: [first.lng, first.lat], zoom: 15 });
      fittedRef.current = true;
    }
  }, [agents]);

  // Redesenha a trilha quando novas posições chegam.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncTrails(map, trails);
  }, [trails]);

  // Liga/desliga a exibição da rota conforme o toggle do operador.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    map.setLayoutProperty('trails-line', 'visibility', showTrails ? 'visible' : 'none');
  }, [showTrails]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
