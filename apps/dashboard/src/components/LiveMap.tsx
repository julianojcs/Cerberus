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

/** Mídia geolocalizada plotada no mapa (pin de câmera). */
export interface MediaMarker {
  id: string;
  lng: number;
  lat: number;
  senderId?: string;
  caption?: string;
}

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

/** Zona (geofence) circular plotada no mapa. */
export interface GeofenceCircle {
  id: string;
  lng: number;
  lat: number;
  radiusMeters: number;
  name: string;
}

/** Anel poligonal aproximando um círculo de `radiusMeters` (MapLibre não tem círculo em metros). */
function circleRing(lng: number, lat: number, radiusMeters: number, points = 64): number[][] {
  const earthR = 6371000;
  const latR = (radiusMeters / earthR) * (180 / Math.PI);
  const lngR = latR / Math.cos((lat * Math.PI) / 180);
  const ring: number[][] = [];
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    ring.push([lng + lngR * Math.cos(theta), lat + latR * Math.sin(theta)]);
  }
  return ring;
}

function geofencesFC(geofences: GeofenceCircle[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geofences.map((g) => ({
      type: 'Feature',
      properties: { name: g.name },
      geometry: { type: 'Polygon', coordinates: [circleRing(g.lng, g.lat, g.radiusMeters)] },
    })),
  };
}

function syncGeofences(map: MlMap, geofences: GeofenceCircle[]): void {
  const source = map.getSource('geofences') as GeoJSONSource | undefined;
  source?.setData(geofencesFC(geofences));
}

/** Geofence em edição (valores ao vivo enquanto se arrasta os handles). */
export interface EditGeofence {
  id: string;
  lng: number;
  lat: number;
  radiusMeters: number;
}

const EARTH_R = 6371000;

function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ponto a `meters` a leste de (lng, lat) — usado como handle de borda (redimensionar). */
function eastPoint(lng: number, lat: number, meters: number): [number, number] {
  const dLng = ((meters / (EARTH_R * Math.cos((lat * Math.PI) / 180))) * 180) / Math.PI;
  return [lng + dLng, lat];
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
  mediaMarkers = [],
  onMediaClick,
  geofences = [],
  onMapClick,
  editGeofence = null,
  onGeofenceMove,
  onGeofenceResize,
}: {
  agents: Record<string, AgentPoint>;
  trails?: AgentTrails;
  showTrails?: boolean;
  mediaMarkers?: MediaMarker[];
  onMediaClick?: (id: string) => void;
  geofences?: GeofenceCircle[];
  onMapClick?: (lng: number, lat: number) => void;
  editGeofence?: EditGeofence | null;
  onGeofenceMove?: (lng: number, lat: number) => void;
  onGeofenceResize?: (radiusMeters: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const mediaMarkersRef = useRef<Record<string, Marker>>({});
  const onMediaClickRef = useRef(onMediaClick);
  onMediaClickRef.current = onMediaClick;
  const geofencesRef = useRef<GeofenceCircle[]>(geofences);
  geofencesRef.current = geofences;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  // Handles de edição de geofence (centro = mover; borda = redimensionar).
  const editCenterRef = useRef<Marker | null>(null);
  const editEdgeRef = useRef<Marker | null>(null);
  const draggingRef = useRef<'center' | 'edge' | null>(null);
  const editGeoRef = useRef<EditGeofence | null>(editGeofence);
  editGeoRef.current = editGeofence;
  const editCbRef = useRef({ move: onGeofenceMove, resize: onGeofenceResize });
  editCbRef.current = { move: onGeofenceMove, resize: onGeofenceResize };
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

    // As camadas de dados só podem ser adicionadas após o estilo carregar.
    map.on('load', () => {
      // Geofences (embaixo): preenchimento + contorno.
      map.addSource('geofences', {
        type: 'geojson',
        data: geofencesFC(geofencesRef.current),
      });
      map.addLayer({
        id: 'geofences-fill',
        type: 'fill',
        source: 'geofences',
        paint: { 'fill-color': '#3fb950', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'geofences-line',
        type: 'line',
        source: 'geofences',
        paint: { 'line-color': '#3fb950', 'line-width': 2, 'line-opacity': 0.7 },
      });
      // Trilhas (por cima das zonas).
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

    // Clique no mapa (usado para posicionar uma nova geofence).
    map.on('click', (e) => onMapClickRef.current?.(e.lngLat.lng, e.lngLat.lat));

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

  // Sincroniza marcadores de mídia (fotos geolocalizadas) — pin de câmera clicável.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const m of mediaMarkers) {
      seen.add(m.id);
      let marker = mediaMarkersRef.current[m.id];
      if (!marker) {
        const el = document.createElement('div');
        el.textContent = '📷';
        el.title = m.caption || m.senderId || 'mídia';
        el.style.cssText =
          'cursor:pointer;font-size:15px;width:26px;height:26px;display:grid;place-items:center;background:#141b24;border:2px solid #c1121f;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,.5);';
        el.addEventListener('click', () => onMediaClickRef.current?.(m.id));
        marker = new maplibregl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map);
        mediaMarkersRef.current[m.id] = marker;
      } else {
        marker.setLngLat([m.lng, m.lat]);
      }
    }
    for (const id of Object.keys(mediaMarkersRef.current)) {
      if (!seen.has(id)) {
        mediaMarkersRef.current[id].remove();
        delete mediaMarkersRef.current[id];
      }
    }
  }, [mediaMarkers]);

  // Redesenha as geofences (zonas) quando mudam.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncGeofences(map, geofences);
  }, [geofences]);

  // Cria/remove os handles arrastáveis ao entrar/sair do modo de edição.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    editCenterRef.current?.remove();
    editEdgeRef.current?.remove();
    editCenterRef.current = null;
    editEdgeRef.current = null;
    if (!editGeofence) return;

    // Centro — arrastar para MOVER a zona.
    const cEl = document.createElement('div');
    cEl.title = 'Arraste para mover a zona';
    cEl.style.cssText =
      'cursor:move;width:20px;height:20px;border-radius:50%;background:#3fb950;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.6);';
    const center = new maplibregl.Marker({ element: cEl, draggable: true })
      .setLngLat([editGeofence.lng, editGeofence.lat])
      .addTo(map);
    center.on('dragstart', () => (draggingRef.current = 'center'));
    center.on('drag', () => {
      const { lng, lat } = center.getLngLat();
      editCbRef.current.move?.(lng, lat);
    });
    center.on('dragend', () => (draggingRef.current = null));
    editCenterRef.current = center;

    // Borda — arrastar para REDIMENSIONAR o raio.
    const eEl = document.createElement('div');
    eEl.title = 'Arraste para redimensionar';
    eEl.style.cssText =
      'cursor:ew-resize;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #3fb950;box-shadow:0 0 6px rgba(0,0,0,.6);';
    const edge = new maplibregl.Marker({ element: eEl, draggable: true })
      .setLngLat(eastPoint(editGeofence.lng, editGeofence.lat, editGeofence.radiusMeters))
      .addTo(map);
    edge.on('dragstart', () => (draggingRef.current = 'edge'));
    edge.on('drag', () => {
      const cur = editGeoRef.current;
      if (!cur) return;
      const e = edge.getLngLat();
      const r = haversineMeters([cur.lng, cur.lat], [e.lng, e.lat]);
      editCbRef.current.resize?.(Math.max(1, Math.round(r)));
    });
    edge.on('dragend', () => (draggingRef.current = null));
    editEdgeRef.current = edge;

    return () => {
      center.remove();
      edge.remove();
      editCenterRef.current = null;
      editEdgeRef.current = null;
    };
  }, [editGeofence?.id]);

  // Reposiciona os handles conforme os valores mudam (sem brigar com o arraste em curso).
  useEffect(() => {
    if (!editGeofence) return;
    if (draggingRef.current !== 'center') {
      editCenterRef.current?.setLngLat([editGeofence.lng, editGeofence.lat]);
    }
    if (draggingRef.current !== 'edge') {
      editEdgeRef.current?.setLngLat(
        eastPoint(editGeofence.lng, editGeofence.lat, editGeofence.radiusMeters),
      );
    }
  }, [editGeofence]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
