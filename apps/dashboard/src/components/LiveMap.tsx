'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MlMap, type Marker, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { initialsOf } from './Avatar';
import { bearingDeg } from '@/lib/geo';

/**
 * Rumo do DESLOCAMENTO pelos dois últimos pontos da trilha do agente. É mais confiável
 * que o `heading` do GPS, que fica velho/ruidoso em baixa velocidade e não bate com a
 * trilha desenhada. Devolve null se não houver movimento medível (pontos coincidentes)
 * — aí o chamador cai no heading do GPS.
 */
function trailBearing(segments: [number, number][][] | undefined): number | null {
  if (!segments) return null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg || seg.length < 2) continue;
    const to = seg[seg.length - 1];
    // Recua até achar um ponto DIFERENTE do último (GPS parado repete a coordenada).
    for (let j = seg.length - 2; j >= 0; j--) {
      const from = seg[j];
      if (from && to && (from[0] !== to[0] || from[1] !== to[1])) return bearingDeg(from, to);
    }
  }
  return null;
}

export interface AgentPoint {
  agentId: string;
  lat: number;
  lng: number;
  heading?: number | null;
  battery?: number;
  activity?: string;
  /** Precisão do fix (m), altitude (m) e velocidade (m/s) — vêm do GPS do aparelho. */
  accuracy?: number;
  altitude?: number;
  speed?: number | null;
  /** ISO da captura — define se o agente está "conectado" (sinal fresco). */
  capturedAt?: string;
  /** Operação de origem (usado só no mapa global do SA — aparece no popup). */
  operationName?: string;
}

/** Modo de locomoção derivado do `activity` do GPS (bicicleta conta como "a pé"). */
type AgentMode = 'still' | 'foot' | 'car';
function agentMode(activity?: string): AgentMode {
  switch (activity) {
    case 'in_vehicle':
      return 'car';
    case 'on_foot':
    case 'walking':
    case 'running':
    case 'on_bicycle':
      return 'foot';
    default:
      return 'still'; // still | unknown | ausente
  }
}

/**
 * FALLBACK de presença: usado só quando o canal `status` ainda não disse nada sobre
 * o agente (app antigo, ou antes da retida chegar). O sinal AUTORITATIVO é o
 * `presence` (status MQTT + LWT) — ver docs/decisions/adr-0004-presenca-do-agente-mqtt-lwt.md.
 *
 * O limiar TEM que respeitar a hibernação do GPS no mobile, senão um agente parado e
 * conectado parece desconectado:
 * - parado: o app hiberna o GPS e só faz um heartbeat a cada 5 min (`heartbeatInterval: 300`);
 * - em deslocamento: as amostras dependem de andar 10 m (`distanceFilter: 10`) e podem
 *   pausar (carro no semáforo) até o `stopTimeout` (5 min) religar o heartbeat.
 * Logo o único piso GARANTIDO de vida é o heartbeat — toleramos 1 perdido.
 */
const HEARTBEAT_MS = 5 * 60_000; // apps/mobile/src/services/geolocation.ts
const FRESH_MS = 2 * HEARTBEAT_MS + 60_000; // 11 min
function isFresh(p: AgentPoint, nowMs: number): boolean {
  return p.capturedAt != null && nowMs - +new Date(p.capturedAt) < FRESH_MS;
}

/**
 * HTML do marcador conforme o estado do agente:
 * - parado: map-pin (conectado, pulsando) ou map-pin-off (desconectado, estático);
 * - carro: puck com a seta `navigation` girada pelo rumo, pulsando;
 * - a pé: bullet com halo desfocado pulsando.
 */
function markerHtml(
  mode: AgentMode,
  fresh: boolean,
  color: string,
  heading?: number | null,
): string {
  if (mode === 'car' || mode === 'foot') {
    // Em deslocamento (carro ou a pé): seta `navigation-2` na COR DO AGENTE, girada pelo
    // rumo, sobre um disco BRANCO (a seta colorida precisa de fundo claro p/ contrastar)
    // com um HALO pulsante ao redor — o "círculo pulsante" de antes.
    return (
      `<span class="agent-nav">` +
      `<span class="agent-nav-halo" style="background:${color}"></span>` +
      `<span class="agent-nav-disc">` +
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="${color}" stroke="${color}" stroke-width="1" ` +
      `stroke-linejoin="round" style="transform:rotate(${Math.round(heading ?? 0)}deg)">` +
      `<polygon points="12 2 19 21 12 17 5 21 12 2"/></svg></span></span>`
    );
  }
  // Parado — pin de public/svg, recolorido por máscara: conectado pulsa (map-pin),
  // desconectado fica estático e riscado (map-pin-off).
  const pin = fresh ? 'agent-pin agent-pulse' : 'agent-pin-off';
  return `<span class="${pin}" style="background:${color}"></span>`;
}

/** Escapa texto interpolado no HTML do popup (nomes de operação/agente). */
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/** Rótulo pt-BR do `activity` do GPS (ver ActivityType em @cerberus/shared). */
const ACTIVITY_LABEL: Record<string, string> = {
  still: 'parado',
  on_foot: 'a pé',
  walking: 'caminhando',
  running: 'correndo',
  in_vehicle: 'em veículo',
  on_bicycle: 'de bicicleta',
  unknown: 'desconhecida',
};

/** Tempo relativo curto em pt-BR ("agora", "há 5 min", "há 2 h", "há 3 d"). */
function agoLabel(iso: string | undefined, nowMs: number): string {
  if (!iso) return '—';
  const min = Math.floor(Math.max(0, nowMs - +new Date(iso)) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/**
 * Linha "rótulo → valor" do popup. Cores EXPLÍCITAS (rótulo em `--muted`, valor em
 * `--text`): usar `opacity` sobre a cor herdada dava rótulo ilegível no fundo escuro.
 */
function row(label: string, value: string): string {
  return (
    `<div style="display:flex;gap:12px;justify-content:space-between;line-height:1.7">` +
    `<span style="color:var(--muted)">${label}</span>` +
    `<span style="color:var(--text);font-weight:600">${value}</span></div>`
  );
}

// Dimensões APROXIMADAS dos balões (o conteúdo é fixo) — bastam para escolher a âncora
// antes de renderizar. O teto de `max-height` no CSS cobre qualquer erro de estimativa.
const INFO_POPUP_W = 235;
const INFO_POPUP_H = 265;
const HOVER_CARD_W = 195;
const HOVER_CARD_H = 60;

/**
 * Escolhe a âncora do balão. A automática do maplibre é ingênua: ela olha se o PONTO
 * está perto da borda, não se o BALÃO cabe — por isso ele ancorava "abaixo" e vazava
 * para fora do mapa.
 *
 * Ordem: abaixo do ponto; se não couber, LATERAL DIREITA centralizada; depois esquerda;
 * e acima como último recurso. (`anchor` nomeia a borda do balão que encosta no ponto:
 * 'top' = balão abaixo; 'left' = balão à direita, centralizado na vertical.)
 */
function pickAnchor(
  map: MlMap,
  lngLat: maplibregl.LngLat,
  w: number,
  h: number,
): maplibregl.PositionAnchor {
  const p = map.project(lngLat);
  const c = map.getContainer();
  const pad = 16;
  if (p.y + h + pad <= c.clientHeight) return 'top';
  const fitsVerticallyCentered = p.y - h / 2 >= 0 && p.y + h / 2 <= c.clientHeight;
  if (fitsVerticallyCentered && p.x + w + pad <= c.clientWidth) return 'left';
  if (fitsVerticallyCentered && p.x - w - pad >= 0) return 'right';
  return p.y - h - pad >= 0 ? 'bottom' : 'top';
}

/** Identidade do agente exibida no card de hover do marcador. */
export interface AgentIdentity {
  name: string;
  username?: string;
  /** Foto do agente. Ausente ⇒ o avatar cai nas INICIAIS (mesma regra do <Avatar/>). */
  photoUrl?: string;
}

/**
 * Card de HOVER do marcador — espelha o card do agente no chat (avatar + nome), com o
 * @usuário no lugar da prévia da mensagem.
 *
 * Mesmo contrato do componente <Avatar/>: usa a FOTO quando houver e cai nas iniciais
 * (via `initialsOf`, para baterem com as do chat) sobre a cor do agente quando não
 * houver. Hoje nenhum agente tem foto — quando o campo existir, basta preencher
 * `photoUrl` na identidade que o card já a exibe.
 */
function hoverCardHtml(
  name: string,
  username: string | undefined,
  color: string,
  photoUrl?: string,
): string {
  const avatar = photoUrl
    ? `<img src="${esc(photoUrl)}" alt="" style="width:34px;height:34px;flex-shrink:0;` +
      `border-radius:50%;object-fit:cover"/>`
    : `<span style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:${color};` +
      `color:#fff;display:grid;place-items:center;font-size:13px;font-weight:700;line-height:1">` +
      `${esc(initialsOf(name))}</span>`;
  return (
    `<div style="display:flex;align-items:center;gap:10px;min-width:150px">` +
    avatar +
    `<div style="min-width:0">` +
    `<div style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap">${esc(name)}</div>` +
    (username
      ? `<div style="font-size:12px;color:var(--muted);white-space:nowrap">@${esc(username)}</div>`
      : '') +
    `</div></div>`
  );
}

/**
 * Ícone de bateria (lucide) escolhido pelo NÍVEL, com a cor acompanhando a gravidade.
 * O popup é DOM cru, então os traços vão inline. Faixas: cheia ≥60, média ≥30,
 * baixa ≥10, alerta <10.
 */
function batteryIcon(level: number | undefined): string {
  if (level == null) return '';
  const pct = level * 100;
  const [body, color] =
    pct >= 60
      ? ['<path d="M10 10v4"/><path d="M14 10v4"/><path d="M6 10v4"/>', 'var(--ok)']
      : pct >= 30
        ? ['<path d="M10 14v-4"/><path d="M6 14v-4"/>', 'var(--text)']
        : pct >= 10
          ? ['<path d="M6 14v-4"/>', '#e3b341']
          : [
              '<path d="M10 17h.01"/><path d="M10 7v6"/>' +
                '<path d="M14 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>' +
                '<path d="M6 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/>',
              '#f87171',
            ];
  // `battery-warning` desenha a própria carcaça (recortada pelo "!"); as demais usam o
  // retângulo padrão. O terminal (`M22 14v-4`) é comum a todas.
  const shell = pct >= 10 ? '<rect x="2" y="6" width="16" height="12" rx="2"/>' : '';
  return (
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">` +
    `${shell}<path d="M22 14v-4"/>${body}</svg>`
  );
}

/**
 * Popup do agente: tudo o que o aparelho manda numa amostra de posição (o dashboard
 * já recebia, só não exibia) + o estado da conexão. Agrupado em Agente / Aparelho /
 * Conexão. `speed` vem em m/s (e negativa quando o GPS não sabe) → km/h.
 */
function popupHtml(p: AgentPoint, online: boolean, nowMs: number, refreshing = false): string {
  const sep = `<div style="height:1px;background:var(--border);margin:8px 0"></div>`;
  const head = (t: string, action = ''): string =>
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px">` +
    `<span style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${t}</span>` +
    `${action}</div>`;
  // Só faz sentido pedir dados a quem está conectado — desconectado, o botão some.
  // `data-refresh` é lido por delegação no elemento do popup (o innerHTML é reescrito
  // a cada atualização de telemetria, o que mataria um listener preso ao botão).
  const refreshBtn = online
    ? `<button type="button" data-refresh aria-label="Atualizar dados do agente" ` +
      `${refreshing ? 'disabled class="agent-refreshing"' : ''} ` +
      `style="display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--border);` +
      `border-radius:6px;background:transparent;color:var(--muted);cursor:pointer">` +
      `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>` +
      `<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>`
    : '';
  const num = (v: number | null | undefined, f: (n: number) => string): string =>
    v == null ? '—' : f(v);

  return (
    `<div style="min-width:190px;font-size:12px;color:var(--text)">` +
    // Cabeçalho: identificação à esquerda, bateria à direita (o ícone dá o nível num
    // relance; a porcentagem exata fica na linha "Bateria").
    `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">` +
    `<div style="min-width:0">` +
    `<div style="font-size:14px;font-weight:700;color:var(--text)">${esc(p.agentId)}</div>` +
    (p.operationName ? `<div style="color:var(--muted)">${esc(p.operationName)}</div>` : '') +
    `</div>` +
    batteryIcon(p.battery) +
    `</div>` +
    sep +
    head('Aparelho', refreshBtn) +
    row(
      'Bateria',
      num(p.battery, (b) => `${Math.round(b * 100)}%`),
    ) +
    row('Atividade', ACTIVITY_LABEL[p.activity ?? 'unknown'] ?? esc(p.activity ?? '—')) +
    row(
      'Velocidade',
      p.speed != null && p.speed >= 0 ? `${(p.speed * 3.6).toFixed(1)} km/h` : '—',
    ) +
    row(
      'Rumo',
      num(p.heading, (h) => `${Math.round(h)}°`),
    ) +
    row(
      'Altitude',
      num(p.altitude, (a) => `${Math.round(a)} m`),
    ) +
    row(
      'Precisão',
      num(p.accuracy, (a) => `±${Math.round(a)} m`),
    ) +
    sep +
    head('Conexão') +
    // Tons CLAROS: o 700 dos marcadores é escuro demais sobre o `--panel` do popup.
    row(
      'Estado',
      online
        ? `<span style="color:var(--ok)">conectado</span>`
        : `<span style="color:#f87171">sem sinal</span>`,
    ) +
    row('Última posição', agoLabel(p.capturedAt, nowMs)) +
    `</div>`
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
  moving?: Record<string, boolean>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const [agentId, segments] of Object.entries(trails)) {
    const color = colors?.[agentId] ?? '#c1121f';
    for (const seg of segments) {
      if (seg.length >= 2) {
        features.push({
          type: 'Feature',
          // `moving` engrossa a trilha do agente em deslocamento (line-width por dado).
          properties: { agentId, color, moving: moving?.[agentId] ?? false },
          geometry: { type: 'LineString', coordinates: seg },
        });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

function syncTrails(
  map: MlMap,
  trails: AgentTrails,
  colors?: Record<string, string>,
  moving?: Record<string, boolean>,
): void {
  const source = map.getSource('trails') as GeoJSONSource | undefined;
  source?.setData(toFeatureCollection(trails, colors, moving));
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
export function circleRing(
  lng: number,
  lat: number,
  radiusMeters: number,
  points = 64,
): number[][] {
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
  if (
    g.shape === 'rectangle' &&
    g.lng != null &&
    g.lat != null &&
    g.widthMeters &&
    g.heightMeters
  ) {
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
  presence,
  agentColorsStrong,
  agentIdentity,
  onRefreshAgent,
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
  /** Presenca por agente (canal `status` + LWT). Sem entrada = desconhecida. */
  presence?: Record<string, boolean>;
  /** Cor da familia no tom 900 por agente — usada SO nos marcadores (contraste). */
  agentColorsStrong?: Record<string, string>;
  /** Nome + @usuario por agente — card de hover do marcador. */
  agentIdentity?: Record<string, AgentIdentity>;
  /** Botao "atualizar" do balao: pede fix ao agente + re-sincroniza com o servidor. */
  onRefreshAgent?: (agentId: string) => void;
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
  const editCbRef = useRef({
    move: onGeofenceMove,
    resize: onGeofenceResize,
    reshape: onGeofenceReshape,
  });
  editCbRef.current = {
    move: onGeofenceMove,
    resize: onGeofenceResize,
    reshape: onGeofenceReshape,
  };
  const strongColorsRef = useRef(agentColorsStrong);
  strongColorsRef.current = agentColorsStrong;
  // Lido dentro dos listeners do marcador (que sao registrados uma vez) — sem ref
  // eles congelariam a identidade da primeira renderizacao.
  const identityRef = useRef(agentIdentity);
  identityRef.current = agentIdentity;
  const onRefreshRef = useRef(onRefreshAgent);
  onRefreshRef.current = onRefreshAgent;
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  // Balão de informações: instância única + de qual agente é + o HTML de cada um
  // (o listener de clique é registrado uma vez, então precisa ler tudo via ref).
  const infoPopupRef = useRef<maplibregl.Popup | null>(null);
  const infoAgentRef = useRef<string | null>(null);
  const infoHtmlRef = useRef<Record<string, string>>({});
  /** agentId → instante do pedido de fix. Enquanto existe, o botão gira. */
  const refreshingRef = useRef<Record<string, number>>({});
  const fittedRef = useRef(false);
  const styleReadyRef = useRef(false);

  // "Agora" em tiques: deixa o sinal do agente ENVELHECER (parado conectado →
  // desconectado) sem depender da chegada de novos dados. 0 no SSR (sem mismatch).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Agentes em deslocamento AGORA — engrossa a trilha (line-width por dado).
  const movingById = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const [id, p] of Object.entries(agents)) out[id] = agentMode(p.activity) !== 'still';
    return out;
  }, [agents]);
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
        paint: {
          'line-color': ['get', 'color'],
          // Trilha mais larga enquanto o agente está em deslocamento.
          'line-width': ['case', ['boolean', ['get', 'moving'], false], 6, 3],
          'line-opacity': 0.7,
        },
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
        // Sem `title`: o hint nativo do navegador está fora do padrão da UI — quem dá
        // a informação é o popup no clique (e o cursor de mão sinaliza que é clicável).
        el.className = 'agent-marker';
        marker = new maplibregl.Marker({ element: el })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        markersRef.current[agentId] = marker;

        // Hover: card com avatar + nome + @usuário (espelha o card do chat). Um único
        // popup reaproveitado entre os marcadores; lê a identidade via ref para não
        // congelar a desta renderização. O clique abre o popup completo, então o card
        // sai de cena para os dois não se sobreporem.
        const showHoverCard = (): void => {
          const m = mapRef.current;
          const mk = markersRef.current[agentId];
          if (!m || !mk) return;
          const ident = identityRef.current?.[agentId];
          // Recriado a cada hover: a âncora do Popup é fixada na construção, e ela
          // depende de onde o marcador está AGORA na tela.
          hoverPopupRef.current?.remove();
          hoverPopupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 16,
            className: 'agent-hover',
            anchor: pickAnchor(m, mk.getLngLat(), HOVER_CARD_W, HOVER_CARD_H),
          });
          hoverPopupRef.current
            .setLngLat(mk.getLngLat())
            .setHTML(
              hoverCardHtml(
                ident?.name ?? agentId,
                ident?.username,
                agentColorsRef.current[agentId] ?? '#c1121f',
                ident?.photoUrl,
              ),
            )
            .addTo(m);
        };
        const hideHoverCard = (): void => {
          hoverPopupRef.current?.remove();
        };
        el.addEventListener('mouseenter', showHoverCard);
        el.addEventListener('mouseleave', hideHoverCard);

        // Clique: abre/fecha o balão de informações. NÃO usamos `marker.setPopup` porque
        // a âncora é fixada na construção do Popup — e ela precisa ser recalculada a cada
        // abertura, conforme a sobra de espaço em torno do marcador naquele momento.
        el.addEventListener('click', (e) => {
          // Sem isto o clique borbulha até o mapa e o `closeOnClick` (ligado por padrão
          // no Popup) fecha o balão no MESMO evento que o abriu — era o que impedia o
          // card de aparecer. O `marker.setPopup`, que deixamos de usar, fazia isto por
          // dentro. Cliques em qualquer outro ponto do mapa seguem fechando o balão.
          e.stopPropagation();
          hideHoverCard();
          const m = mapRef.current;
          const mk = markersRef.current[agentId];
          if (!m || !mk) return;
          const wasOpen = infoAgentRef.current === agentId;
          infoPopupRef.current?.remove();
          if (wasOpen) {
            infoAgentRef.current = null; // segundo clique fecha
            return;
          }
          infoAgentRef.current = agentId;
          infoPopupRef.current = new maplibregl.Popup({
            offset: 14,
            anchor: pickAnchor(m, mk.getLngLat(), INFO_POPUP_W, INFO_POPUP_H),
          })
            .setLngLat(mk.getLngLat())
            .setHTML(infoHtmlRef.current[agentId] ?? '')
            .addTo(m);
          infoPopupRef.current.on('close', () => {
            if (infoAgentRef.current === agentId) infoAgentRef.current = null;
          });
          // Delegacao: o listener fica no ELEMENTO do popup, nao no botao — o innerHTML
          // e reescrito a cada telemetria nova e levaria junto um listener no botao.
          infoPopupRef.current.getElement()?.addEventListener('click', (ev) => {
            const btn = (ev.target as HTMLElement)?.closest('[data-refresh]');
            if (btn instanceof HTMLButtonElement && !btn.disabled) {
              ev.stopPropagation();
              refreshingRef.current[agentId] = Date.now();
              // Feedback na hora, sem esperar o próximo ciclo de render do balão.
              btn.disabled = true;
              btn.classList.add('agent-refreshing');
              onRefreshRef.current?.(agentId);
            }
          });
        });
      }
      // Forma do marcador conforme o estado; só redesenha quando o estado muda
      // (o efeito re-roda a cada tique de `nowMs` para o sinal poder envelhecer).
      const el = marker.getElement();
      // Marcador no tom 900 (mais forte) — o 500 da trilha some sobre o mapa claro.
      const strong = strongColorsRef.current?.[agentId] ?? color;
      const mode = agentMode(point.activity);
      // Presença explícita (status MQTT + LWT) manda; sem ela, cai no proxy de frescor.
      const fresh = presence?.[agentId] ?? isFresh(point, nowMs);
      // Direção da seta = rumo da TRILHA (o do GPS não bate); GPS só como fallback.
      const heading = trailBearing(trailsRef.current[agentId]) ?? point.heading ?? 0;
      const stateKey = `${mode}|${fresh}|${strong}|${Math.round(heading)}`;
      if (el.dataset.state !== stateKey) {
        el.innerHTML = markerHtml(mode, fresh, strong, heading);
        el.dataset.state = stateKey;
      }
      marker.setLngLat([point.lng, point.lat]);
      // Guarda o HTML de cada agente (o clique lê daqui) e atualiza ao vivo o balão que
      // estiver aberto — a telemetria continua chegando enquanto ele está na tela.
      // Para de girar quando o agente RESPONDEU (posição mais nova que o pedido) ou
      // quando o pedido envelheceu — senão o botão giraria para sempre.
      const askedAt = refreshingRef.current[agentId];
      if (
        askedAt != null &&
        (+new Date(point.capturedAt ?? 0) > askedAt || nowMs - askedAt > 20_000)
      ) {
        delete refreshingRef.current[agentId];
      }
      infoHtmlRef.current[agentId] = popupHtml(
        point,
        fresh,
        nowMs,
        refreshingRef.current[agentId] != null,
      );
      if (infoAgentRef.current === agentId) {
        infoPopupRef.current?.setLngLat([point.lng, point.lat]);
        infoPopupRef.current?.setHTML(infoHtmlRef.current[agentId]);
      }
    }

    // Enquadra a primeira posição recebida.
    const first = Object.values(agents)[0];
    if (first && !fittedRef.current) {
      map.easeTo({ center: [first.lng, first.lat], zoom: 15 });
      fittedRef.current = true;
    }
  }, [agents, agentColors, presence, nowMs]);

  // Redesenha a trilha quando novas posições chegam (ou quando o deslocamento muda,
  // que altera a largura do traçado).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncTrails(map, trails, agentColorsRef.current, movingById);
  }, [trails, movingById]);

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
