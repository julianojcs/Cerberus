'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MlMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface AgentPoint {
  agentId: string;
  lat: number;
  lng: number;
  heading?: number | null;
  battery?: number;
  activity?: string;
}

/**
 * Mapa de plotagem em tempo real. Recebe as posições correntes de cada agente
 * (mapa agentId -> ponto) e atualiza/anima os marcadores. Usa MapLibre GL com
 * tiles OSM (sem chave de API), adequado ao MVP custo-zero.
 */
export function LiveMap({ agents }: { agents: Record<string, AgentPoint> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const fittedRef = useRef(false);

  // Inicializa o mapa uma única vez.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
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
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
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
        marker = new maplibregl.Marker({ element: el }).setLngLat([point.lng, point.lat]).addTo(map);
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

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
