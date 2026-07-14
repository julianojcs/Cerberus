'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MlMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

/** Agente plotado no mapa global — carrega a operação a que pertence (cor + rótulo). */
export interface GlobalAgent {
  key: string; // chave única do marcador (agentId é único por usuário)
  agentId: string;
  operationId: string;
  operationName: string;
  color: string; // hex (cor da operação)
  lat: number;
  lng: number;
  battery?: number;
  activity?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Mapa global do SuperAdmin: todos os agentes de TODAS as operações num só mapa,
 * cada um na cor da sua operação. Enxuto de propósito — só marcadores + enquadre;
 * não há zonas/rotas/edição (isso é da visão por-operação). Reusa o mesmo estilo
 * OSM (sem chave de API) do mapa ao vivo.
 */
export function GlobalMap({
  agents,
  fitPoints = [],
  fitNonce = 0,
}: {
  agents: GlobalAgent[];
  /** Pontos [lng,lat] a enquadrar quando `fitNonce` muda (todos, ou de uma operação). */
  fitPoints?: [number, number][];
  fitNonce?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const fitPointsRef = useRef<[number, number][]>(fitPoints);
  fitPointsRef.current = fitPoints;

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
      zoom: 11,
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Sincroniza os marcadores com o estado de agentes (cria/atualiza/remove).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.key);
      let marker = markersRef.current[a.key];
      if (!marker) {
        const el = document.createElement('div');
        el.style.cssText =
          'width:18px;height:18px;border-radius:50%;border:2px solid #fff;transition:background .2s;';
        marker = new maplibregl.Marker({ element: el }).setLngLat([a.lng, a.lat]).addTo(map);
        marker.setPopup(new maplibregl.Popup({ offset: 12 }));
        markersRef.current[a.key] = marker;
      }
      const el = marker.getElement();
      el.title = `${a.agentId} · ${a.operationName}`;
      el.style.background = a.color;
      el.style.boxShadow = `0 0 8px ${a.color}`;
      marker.setLngLat([a.lng, a.lat]);
      marker
        .getPopup()
        ?.setHTML(
          `<strong>${esc(a.agentId)}</strong><br/>` +
            `<span style="opacity:.75">${esc(a.operationName)}</span><br/>` +
            `bat: ${a.battery != null ? Math.round(a.battery * 100) + '%' : '—'}` +
            `${a.activity ? ' · ' + esc(a.activity) : ''}`,
        );
    }
    // Remove marcadores de agentes que sumiram.
    for (const key of Object.keys(markersRef.current)) {
      if (!seen.has(key)) {
        markersRef.current[key].remove();
        delete markersRef.current[key];
      }
    }
  }, [agents]);

  // Enquadra os pontos pedidos quando `fitNonce` muda (enquadrar tudo / focar operação).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitNonce) return;
    const pts = fitPointsRef.current;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: 15, duration: 600 });
      return;
    }
    const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 600 });
  }, [fitNonce]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
