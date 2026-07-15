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
  /** Operação de origem (usado só no mapa global do SA — aparece no popup). */
  operationName?: string;
}

/** Escapa texto interpolado no HTML do popup (nomes de operação/agente). */
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/**
 * Seta (imagem SDF) para o efeito "Sentido das trilhas". Desenhada apontando para
 * +x (leste); com `symbol-placement: 'line'` o MapLibre a rotaciona para seguir a
 * direção da linha — e como as coordenadas estão em ordem cronológica, isso aponta
 * no sentido do deslocamento. SDF (`{ sdf: true }`) permite recolorir por dado
 * (`icon-color`), fazendo cada seta sair na cor do agente.
 */
function makeDirectionArrow(size = 40): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new ImageData(size, size);
  // No modo SDF só o canal alfa importa; a cor de preenchimento é irrelevante.
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(size * 0.3, size * 0.2);
  ctx.lineTo(size * 0.82, size * 0.5);
  ctx.lineTo(size * 0.3, size * 0.8);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Trilha por agente: LISTA DE SEGMENTOS (cada um em ordem cronológica, [lng, lat]).
 * A quebra em segmentos evita ligar por uma reta dois pontos separados por um gap
 * de transmissão (o "pulo" que não aconteceu de verdade).
 */
export type AgentTrails = Record<string, [number, number][][]>;

/** Mídia geolocalizada plotada no mapa (pin de câmera). */
export interface MediaMarker {
  id: string;
  lng: number;
  lat: number;
  senderId?: string;
  caption?: string;
}

/** Rota (segmento) selecionada plotada na cor do agente. */
export interface PlottedRoute {
  id: string;
  points: [number, number][];
  color: string; // hex (cor do agente)
  dashed?: boolean; // conector entre rotas (linha tracejada)
}

function routesFC(routes: PlottedRoute[], dashed: boolean): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes
      .filter((r) => !!r.dashed === dashed && r.points.length >= 2)
      .map((r) => ({
        type: 'Feature',
        properties: { color: r.color },
        geometry: { type: 'LineString', coordinates: r.points },
      })),
  };
}

function syncRoutes(map: MlMap, routes: PlottedRoute[]): void {
  (map.getSource('agent-routes') as GeoJSONSource | undefined)?.setData(routesFC(routes, false));
  (map.getSource('agent-routes-dashed') as GeoJSONSource | undefined)?.setData(
    routesFC(routes, true),
  );
}

function toFeatureCollection(
  trails: AgentTrails,
  colors?: Record<string, string>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const [agentId, segments] of Object.entries(trails)) {
    const color = colors?.[agentId] ?? '#c1121f';
    for (const seg of segments) {
      if (seg.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { agentId, color },
          geometry: { type: 'LineString', coordinates: seg },
        });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

function syncTrails(map: MlMap, trails: AgentTrails, colors?: Record<string, string>): void {
  const source = map.getSource('trails') as GeoJSONSource | undefined;
  source?.setData(toFeatureCollection(trails, colors));
}

/**
 * Zona (geofence) plotada no mapa — multiformato (Fase 4). Círculo/retângulo usam
 * `lng`/`lat` como centro; polígono usa `vertices`. `shape` ausente ⇒ círculo.
 */
export interface GeofenceCircle {
  id: string;
  name: string;
  color?: string; // hex (tom 500 resolvido da familia Tailwind)
  shape?: string; // 'circle' | 'rectangle' | 'polygon'
  lng?: number;
  lat?: number;
  radiusMeters?: number; // círculo
  widthMeters?: number; // retângulo
  heightMeters?: number;
  rotationDeg?: number;
  vertices?: [number, number][]; // polígono [[lng,lat],…]
}

const EARTH_R_M = 6371000;
const M_PER_DEG_LAT_R = 110540;

/** Anel poligonal aproximando um círculo de `radiusMeters` (MapLibre não tem círculo em metros). */
export function circleRing(lng: number, lat: number, radiusMeters: number, points = 64): number[][] {
  const latR = (radiusMeters / EARTH_R_M) * (180 / Math.PI);
  const lngR = latR / Math.cos((lat * Math.PI) / 180);
  const ring: number[][] = [];
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    ring.push([lng + lngR * Math.cos(theta), lat + latR * Math.sin(theta)]);
  }
  return ring;
}

/** Anel de um retângulo (metros locais rotacionados `+rotationDeg` CCW → lng/lat). */
export function rectangleRing(
  lng: number,
  lat: number,
  w: number,
  h: number,
  rotationDeg: number,
): number[][] {
  const th = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const hw = w / 2;
  const hh = h / 2;
  const mPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const corners: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const ring = corners.map(([x, y]) => {
    const east = x * cos - y * sin;
    const north = x * sin + y * cos;
    return [lng + east / mPerLng, lat + north / M_PER_DEG_LAT_R];
  });
  ring.push(ring[0]); // fecha o anel
  return ring;
}

/** Anel (fechado) da zona conforme a forma. */
function ringFor(g: GeofenceCircle): number[][] {
  if (g.shape === 'polygon' && g.vertices && g.vertices.length >= 3) {
    const ring: number[][] = g.vertices.map(([x, y]) => [x, y]);
    ring.push(ring[0]);
    return ring;
  }
  if (g.shape === 'rectangle' && g.lng != null && g.lat != null && g.widthMeters && g.heightMeters) {
    return rectangleRing(g.lng, g.lat, g.widthMeters, g.heightMeters, g.rotationDeg ?? 0);
  }
  return circleRing(g.lng ?? 0, g.lat ?? 0, g.radiusMeters ?? 0);
}

function geofencesFC(geofences: GeofenceCircle[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geofences.map((g) => ({
      type: 'Feature',
      properties: { name: g.name, color: g.color ?? '#22c55e' },
      geometry: { type: 'Polygon', coordinates: [ringFor(g)] },
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
  /** Fase 4: forma. O handle de raio (borda) só aparece no círculo. */
  shape?: string;
  /** Polígono (Fase 4b): vértices editáveis [[lng,lat],…]. */
  vertices?: [number, number][];
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
  showTrailDirection = false,
  routes = [],
  agentColors = {},
  mediaMarkers = [],
  onMediaClick,
  geofences = [],
  showGeofences = true,
  onMapClick,
  editGeofence = null,
  onGeofenceMove,
  onGeofenceResize,
  onGeofenceReshape,
  focus = null,
  fitNonce = 0,
  fitPoints,
}: {
  agents: Record<string, AgentPoint>;
  trails?: AgentTrails;
  showTrails?: boolean;
  /** Efeito "Sentido das trilhas": setas ao longo das trilhas e rotas. */
  showTrailDirection?: boolean;
  routes?: PlottedRoute[];
  agentColors?: Record<string, string>;
  mediaMarkers?: MediaMarker[];
  onMediaClick?: (id: string) => void;
  geofences?: GeofenceCircle[];
  showGeofences?: boolean;
  onMapClick?: (lng: number, lat: number) => void;
  editGeofence?: EditGeofence | null;
  onGeofenceMove?: (lng: number, lat: number) => void;
  onGeofenceResize?: (radiusMeters: number) => void;
  /** Polígono (Fase 4b): emite a lista de vértices atualizada ao arrastar/adicionar/remover. */
  onGeofenceReshape?: (vertices: [number, number][]) => void;
  focus?: { lng: number; lat: number; bearing: number; type: 'enter' | 'exit' } | null;
  /** Muda de valor → o mapa enquadra (fitBounds) todas as rotas plotadas. */
  fitNonce?: number;
  /**
   * Pontos [lng,lat] a enquadrar quando `fitNonce` muda. Se omitido/vazio, cai no
   * padrão (enquadra as rotas plotadas) — a live page não passa isto. O mapa global
   * do SA passa marcadores/rotas de uma operação (ou de tudo) para enquadrar.
   */
  fitPoints?: [number, number][];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Record<string, Marker>>({});
  const mediaMarkersRef = useRef<Record<string, Marker>>({});
  const onMediaClickRef = useRef(onMediaClick);
  onMediaClickRef.current = onMediaClick;
  const geofencesRef = useRef<GeofenceCircle[]>(geofences);
  geofencesRef.current = geofences;
  const showGeofencesRef = useRef(showGeofences);
  showGeofencesRef.current = showGeofences;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  // Handles de edição de geofence (centro = mover; borda = redimensionar).
  const editCenterRef = useRef<Marker | null>(null);
  const editEdgeRef = useRef<Marker | null>(null);
  // Polígono (4b): um marcador por vértice (arrastável) + um "add" no midpoint de cada aresta.
  const editVertsRef = useRef<Marker[]>([]);
  const editMidsRef = useRef<Marker[]>([]);
  const dragVertexRef = useRef<number | null>(null);
  const draggingRef = useRef<'center' | 'edge' | 'vertex' | null>(null);
  const focusMarkerRef = useRef<Marker | null>(null);
  const editGeoRef = useRef<EditGeofence | null>(editGeofence);
  editGeoRef.current = editGeofence;
  const editCbRef = useRef({ move: onGeofenceMove, resize: onGeofenceResize, reshape: onGeofenceReshape });
  editCbRef.current = { move: onGeofenceMove, resize: onGeofenceResize, reshape: onGeofenceReshape };
  const fittedRef = useRef(false);
  const styleReadyRef = useRef(false);
  // Mantém a trilha/visibilidade correntes acessíveis ao handler de 'load'
  // (evita closure obsoleto na inicialização assíncrona do estilo).
  const trailsRef = useRef<AgentTrails>(trails);
  trailsRef.current = trails;
  const showTrailsRef = useRef(showTrails);
  showTrailsRef.current = showTrails;
  const showTrailDirectionRef = useRef(showTrailDirection);
  showTrailDirectionRef.current = showTrailDirection;
  const routesRef = useRef<PlottedRoute[]>(routes);
  routesRef.current = routes;
  const agentColorsRef = useRef<Record<string, string>>(agentColors);
  agentColorsRef.current = agentColors;
  const fitPointsRef = useRef<[number, number][] | undefined>(fitPoints);
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
      zoom: 12,
    });
    mapRef.current = map;

    // As camadas de dados só podem ser adicionadas após o estilo carregar.
    map.on('load', () => {
      // Seta reutilizada pelo efeito "Sentido das trilhas" (SDF → recolorível).
      if (!map.hasImage('trail-arrow')) {
        map.addImage('trail-arrow', makeDirectionArrow(), { sdf: true });
      }
      // Geofences (embaixo): preenchimento + contorno.
      map.addSource('geofences', {
        type: 'geojson',
        data: geofencesFC(geofencesRef.current),
      });
      const geoVisibility = showGeofencesRef.current ? 'visible' : 'none';
      map.addLayer({
        id: 'geofences-fill',
        type: 'fill',
        source: 'geofences',
        layout: { visibility: geoVisibility },
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'geofences-line',
        type: 'line',
        source: 'geofences',
        layout: { visibility: geoVisibility },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.7 },
      });
      // Trilhas (por cima das zonas).
      map.addSource('trails', {
        type: 'geojson',
        data: toFeatureCollection(trailsRef.current, agentColorsRef.current),
      });
      map.addLayer({
        id: 'trails-line',
        type: 'line',
        source: 'trails',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
          visibility: showTrailsRef.current ? 'visible' : 'none',
        },
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.7 },
      });
      // Rotas selecionadas por agente (por cima das trilhas), cor dirigida por dado.
      map.addSource('agent-routes', { type: 'geojson', data: routesFC(routesRef.current, false) });
      map.addLayer({
        id: 'agent-routes-line',
        type: 'line',
        source: 'agent-routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.9 },
      });
      // Conectores entre rotas (opção "ligar rotas"): linha tracejada, mais fina.
      map.addSource('agent-routes-dashed', {
        type: 'geojson',
        data: routesFC(routesRef.current, true),
      });
      map.addLayer({
        id: 'agent-routes-dashed-line',
        type: 'line',
        source: 'agent-routes-dashed',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.85,
          'line-dasharray': [2, 2],
        },
      });
      // Efeito "Sentido das trilhas": setas ao longo das linhas indicando a direção
      // do deslocamento (por cima das trilhas e das rotas). Uma camada por fonte;
      // `icon-color` herda a cor do agente. Visibilidade inicial vem do ref.
      const directionVisibility: 'visible' | 'none' = showTrailDirectionRef.current
        ? 'visible'
        : 'none';
      const directionLayout = {
        visibility: directionVisibility,
        'symbol-placement': 'line' as const,
        'symbol-spacing': 110,
        'icon-image': 'trail-arrow',
        // Fonte 40px × 0.75 ≈ 30px — mesmo porte das setas de cruzamento de zona.
        'icon-size': 0.75,
        'icon-rotation-alignment': 'map' as const,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      };
      map.addLayer({
        id: 'trails-direction',
        type: 'symbol',
        source: 'trails',
        layout: directionLayout,
        paint: { 'icon-color': ['get', 'color'], 'icon-opacity': 0.9 },
      });
      map.addLayer({
        id: 'agent-routes-direction',
        type: 'symbol',
        source: 'agent-routes',
        layout: directionLayout,
        paint: { 'icon-color': ['get', 'color'] },
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
      const color = agentColorsRef.current[agentId] ?? '#c1121f';
      let marker = markersRef.current[agentId];
      if (!marker) {
        const el = document.createElement('div');
        el.title = agentId;
        el.style.cssText =
          'width:18px;height:18px;border-radius:50%;border:2px solid #fff;transition:background .2s;';
        marker = new maplibregl.Marker({ element: el })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        marker.setPopup(new maplibregl.Popup({ offset: 12 }));
        markersRef.current[agentId] = marker;
      }
      // Aplica a cor do agente (mantém consistência com o card e a rota no mapa).
      const el = marker.getElement();
      el.style.background = color;
      el.style.boxShadow = `0 0 8px ${color}`;
      marker.setLngLat([point.lng, point.lat]);
      marker
        .getPopup()
        ?.setHTML(
          `<strong>${esc(agentId)}</strong>` +
            (point.operationName
              ? `<br/><span style="opacity:.75">${esc(point.operationName)}</span>`
              : '') +
            `<br/>bat: ${point.battery != null ? Math.round(point.battery * 100) + '%' : '—'}` +
            (point.activity ? `<br/>${esc(point.activity)}` : ''),
        );
    }

    // Enquadra a primeira posição recebida.
    const first = Object.values(agents)[0];
    if (first && !fittedRef.current) {
      map.easeTo({ center: [first.lng, first.lat], zoom: 15 });
      fittedRef.current = true;
    }
  }, [agents, agentColors]);

  // Redesenha a trilha quando novas posições chegam.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncTrails(map, trails, agentColorsRef.current);
  }, [trails]);

  // Redesenha as rotas selecionadas (cores por agente) quando a seleção muda.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncRoutes(map, routes);
  }, [routes]);

  // Enquadra (fitBounds) quando `fitNonce` muda: usa `fitPoints` se fornecido
  // (mapa global), senão as rotas plotadas (comportamento padrão da live page).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitNonce) return;
    const explicit = fitPointsRef.current;
    const pts = explicit && explicit.length ? explicit : routesRef.current.flatMap((r) => r.points);
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: 15, duration: 600 });
      return;
    }
    const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 600 });
  }, [fitNonce]);

  // Liga/desliga a exibição da rota conforme o toggle do operador.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    map.setLayoutProperty('trails-line', 'visibility', showTrails ? 'visible' : 'none');
  }, [showTrails]);

  // Liga/desliga o efeito "Sentido das trilhas" (setas nas trilhas e nas rotas).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const v = showTrailDirection ? 'visible' : 'none';
    map.setLayoutProperty('trails-direction', 'visibility', v);
    map.setLayoutProperty('agent-routes-direction', 'visibility', v);
  }, [showTrailDirection]);

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
    editVertsRef.current.forEach((m) => m.remove());
    editMidsRef.current.forEach((m) => m.remove());
    editVertsRef.current = [];
    editMidsRef.current = [];
    if (!editGeofence) return;

    // POLÍGONO (4b): alça arrastável em cada vértice + alça "add" no midpoint de cada
    // aresta (estilo clippy). Sem centro/borda — a forma é definida só pelos vértices.
    if ((editGeofence.shape ?? 'circle') === 'polygon') {
      const verts = editGeofence.vertices ?? [];
      verts.forEach((v, i) => {
        const vEl = document.createElement('div');
        vEl.title = 'Arraste para mover · duplo-clique remove';
        vEl.style.cssText =
          'cursor:move;width:16px;height:16px;border-radius:50%;background:#fff;border:3px solid #3fb950;box-shadow:0 0 6px rgba(0,0,0,.6);';
        const vm = new maplibregl.Marker({ element: vEl, draggable: true }).setLngLat(v).addTo(map);
        vm.on('dragstart', () => {
          draggingRef.current = 'vertex';
          dragVertexRef.current = i;
        });
        vm.on('drag', () => {
          const cur = editGeoRef.current;
          if (!cur?.vertices) return;
          const { lng, lat } = vm.getLngLat();
          const next = cur.vertices.map((vv, k): [number, number] => (k === i ? [lng, lat] : vv));
          editCbRef.current.reshape?.(next);
        });
        vm.on('dragend', () => {
          draggingRef.current = null;
          dragVertexRef.current = null;
        });
        // Duplo-clique remove o vértice (mantém no mínimo um triângulo).
        vEl.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          const cur = editGeoRef.current;
          if (!cur?.vertices || cur.vertices.length <= 3) return;
          editCbRef.current.reshape?.(cur.vertices.filter((_, k) => k !== i));
        });
        editVertsRef.current.push(vm);
      });
      // "Add" nos midpoints — clique insere um vértice naquela aresta.
      verts.forEach((v, i) => {
        const nextV = verts[(i + 1) % verts.length];
        if (!nextV) return;
        const mid: [number, number] = [(v[0] + nextV[0]) / 2, (v[1] + nextV[1]) / 2];
        const mEl = document.createElement('div');
        mEl.title = 'Clique para adicionar vértice';
        mEl.style.cssText =
          'cursor:copy;width:12px;height:12px;border-radius:50%;background:#3fb950;border:2px solid #fff;opacity:.65;';
        const mm = new maplibregl.Marker({ element: mEl }).setLngLat(mid).addTo(map);
        mEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const cur = editGeoRef.current;
          if (!cur?.vertices) return;
          const at = mm.getLngLat();
          const nv = cur.vertices.slice();
          nv.splice(i + 1, 0, [at.lng, at.lat]);
          editCbRef.current.reshape?.(nv);
        });
        editMidsRef.current.push(mm);
      });

      return () => {
        editVertsRef.current.forEach((m) => m.remove());
        editMidsRef.current.forEach((m) => m.remove());
        editVertsRef.current = [];
        editMidsRef.current = [];
      };
    }

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

    // Borda — arrastar para REDIMENSIONAR o raio. Só CÍRCULO (retângulo/polígono
    // ajustam por outros controles). Move (centro) vale para todas as formas.
    if ((editGeofence.shape ?? 'circle') === 'circle') {
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
    }

    return () => {
      center.remove();
      editEdgeRef.current?.remove();
      editCenterRef.current = null;
      editEdgeRef.current = null;
    };
    // Reconstrói ao trocar de zona/forma ou quando o nº de vértices muda (add/remove).
  }, [editGeofence?.id, editGeofence?.shape, editGeofence?.vertices?.length]);

  // Liga/desliga a exibição das zonas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const v = showGeofences ? 'visible' : 'none';
    map.setLayoutProperty('geofences-fill', 'visibility', v);
    map.setLayoutProperty('geofences-line', 'visibility', v);
  }, [showGeofences]);

  // Ao clicar num alerta: voa até a BORDA da zona e planta uma SETA rotacionada
  // indicando a direção (entrada = para dentro; saída = para fora).
  useEffect(() => {
    const map = mapRef.current;
    focusMarkerRef.current?.remove();
    focusMarkerRef.current = null;
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lng, focus.lat], zoom: 16 });
    const color = focus.type === 'enter' ? '#3fb950' : '#e3b341';
    const el = document.createElement('div');
    el.title = focus.type === 'enter' ? 'Entrada na zona' : 'Saída da zona';
    // Seta apontando para cima (norte); a rotação do Marker a alinha ao rumo.
    el.innerHTML =
      `<svg width="30" height="30" viewBox="0 0 24 24" fill="${color}" stroke="#0b0f14" ` +
      `stroke-width="1.5" stroke-linejoin="round"><path d="M12 2 L20 21 L12 16 L4 21 Z"/></svg>`;
    focusMarkerRef.current = new maplibregl.Marker({
      element: el,
      rotation: focus.bearing,
      rotationAlignment: 'map',
    })
      .setLngLat([focus.lng, focus.lat])
      .addTo(map);
  }, [focus]);

  // Reposiciona os handles conforme os valores mudam (sem brigar com o arraste em curso).
  useEffect(() => {
    if (!editGeofence) return;
    if ((editGeofence.shape ?? 'circle') === 'polygon') {
      const verts = editGeofence.vertices ?? [];
      // Vértices: reposiciona todos menos o que está sendo arrastado.
      verts.forEach((v, i) => {
        if (dragVertexRef.current === i) return;
        editVertsRef.current[i]?.setLngLat(v);
      });
      // Midpoints: seguem o centro de cada aresta (acompanham qualquer arraste).
      editMidsRef.current.forEach((m, i) => {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        if (a && b) m.setLngLat([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      });
      return;
    }
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
