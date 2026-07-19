import { useCallback, useEffect, useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

export interface TrackPoint {
  lat: number;
  lng: number;
}

/**
 * Mapa embarcado do próprio agente (WebView + Leaflet + tiles OSM). Reaproveita
 * a mesma stack sem-chave do dashboard, evitando a dependência do Google Maps
 * (que exigiria API key + billing) e o conflito de play-services no Android.
 *
 * Rotação via plugin `leaflet-rotate`: dois dedos giram o mapa (manual) e o botão
 * de bússola reseta para o norte. O modo `headingUp` (girar com o movimento) usa
 * o `heading` do GPS para manter a direção de deslocamento sempre para cima.
 *
 * Os tiles do mapa exigem rede — em zona de sombra o mapa não carrega, mas o
 * bufferização de posições (outbox) continua funcionando normalmente.
 */
const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js"></script>
<style>
html,body,#map{height:100%;margin:0;background:#0b0f14}
.dest{font-size:22px;line-height:30px;text-align:center;text-shadow:0 0 5px #000,0 0 2px #000}
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    touchZoom: true,
    bounceAtZoomLimits: false,
    maxZoom: 21,
    // leaflet-rotate: rotação por gesto de dois dedos + botão de bússola (reset ao norte).
    rotate: true,
    touchRotate: true,
    rotateControl: { closeOnZeroBearing: false, position: 'topright' },
    bearing: 0,
  }).setView([-19.9319, -43.9386], 16);
  // maxNativeZoom: 19 = último nível com tile real do OSM; acima disso o Leaflet
  // amplia o tile (fica levemente borrado, mas permite aproximar mais a pé).
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 21,
    maxNativeZoom: 19,
  }).addTo(map);
  // Rota PLANEJADA (issue #131), distinta do rastro JÁ percorrido (vermelho): azul com
  // "casing" escuro por baixo, o padrão de navegação veicular. Declarada ANTES da
  // trilha de propósito — no Leaflet quem entra depois desenha por cima, e o rastro
  // precisa ficar visível sobre a rota.
  var routeCasing = L.polyline([], { color: '#0b0f14', weight: 11, opacity: 0.9 }).addTo(map);
  var routeLine = L.polyline([], { color: '#2f81f7', weight: 6, opacity: 0.95 }).addTo(map);
  var destMarker = null;
  var routeFitKey = 0;
  var line = L.polyline([], { color: '#c1121f', weight: 4, opacity: 0.85 }).addTo(map);
  var meMarker = null;
  var fitted = false;
  // Modo "escolher destino": só então o toque no mapa vira evento. Sem isto qualquer
  // arraste do mapa abriria a confirmação de destino.
  var pickMode = false;
  // Marcador ÚNICO "você está aqui" (azul), distinto da trilha vermelha. Segue a
  // posição ao vivo (__update) e também é reposicionado ao centralizar (__focus) —
  // um só ponto, sem duplicar/"pular" entre um marcador de trilha e outro de foco.
  function setMe(lat, lng) {
    if (!meMarker) {
      meMarker = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#2f81f7', fillOpacity: 1 }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lng]);
    }
  }
  // Centraliza na posição do agente (sob demanda), mesmo sem transmitir.
  window.__focus = function (lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    setMe(lat, lng);
    map.setView([lat, lng], Math.max(map.getZoom(), 17));
    fitted = true;
  };
  window.__update = function (track, showRoute, headingUp, heading) {
    if (!track || !track.length) return;
    var latlngs = track.map(function (p) { return [p.lat, p.lng]; });
    // O marcador (posição atual) fica sempre visível; a rota liga/desliga.
    line.setLatLngs(showRoute ? latlngs : []);
    var last = latlngs[latlngs.length - 1];
    // Marcador único "você está aqui" na cabeça da trilha, ao vivo.
    setMe(last[0], last[1]);
    if (!fitted) { map.setView(last, 18); fitted = true; }
    else { map.panTo(last); }
    // Modo bússola: alinha o topo do mapa à direção de deslocamento (heading do GPS).
    // heading é graus horários a partir do norte; só é confiável em movimento (>= 0).
    // Se girar ao contrário no device, troque para (360 - heading) % 360.
    if (headingUp && typeof heading === 'number' && heading >= 0 && map.setBearing) {
      map.setBearing(heading);
    }
  };
  // Rota planejada. O parâmetro points chega JÁ em [lat, lng]: a transposição do GeoJSON
  // [lng, lat] é feita uma única vez, do lado tipado (src/shared/geo.ts) — ver
  // .claude/rules/geospatial-coordinates.md.
  window.__route = function (points, dest, isFallback, fitKey) {
    var has = points && points.length > 1;
    routeCasing.setLatLngs(has ? points : []);
    routeLine.setLatLngs(has ? points : []);
    // Traçado direto (provedor de rotas fora): pontilhado âmbar deixa explícito que
    // NÃO é um trajeto por vias e que não haverá instrução de manobra.
    routeLine.setStyle(
      isFallback
        ? { dashArray: '10 8', color: '#e3b341' }
        : { dashArray: null, color: '#2f81f7' }
    );
    if (dest) {
      if (!destMarker) {
        destMarker = L.marker([dest.lat, dest.lng], {
          icon: L.divIcon({ className: '', html: '<div class="dest">🏁</div>', iconSize: [30, 30], iconAnchor: [15, 15] })
        }).addTo(map);
      } else {
        destMarker.setLatLng([dest.lat, dest.lng]);
      }
      destMarker.bindTooltip(dest.label || 'Destino', { direction: 'top', offset: [0, -14] });
    } else if (destMarker) {
      map.removeLayer(destMarker);
      destMarker = null;
    }
    // Enquadra o trajeto inteiro só quando a ROTA muda (fitKey), nunca a cada fix —
    // senão o mapa daria zoom-out a cada atualização de posição.
    if (has && fitKey && fitKey !== routeFitKey) {
      routeFitKey = fitKey;
      try { map.fitBounds(routeCasing.getBounds(), { padding: [30, 30] }); fitted = true; } catch (e) {}
    }
  };
  // Ponto escolhido mas AINDA NÃO confirmado (toque no mapa ou acerto da busca). É um
  // marcador à parte do destino da rota (🏁): enquanto o agente lê o diálogo de
  // confirmação, uma rota anterior pode continuar ativa na tela, e misturar os dois
  // marcadores faria parecer que a rota já mudou de destino.
  var pinMarker = null;
  window.__pin = function (pin, center) {
    if (!pin) {
      if (pinMarker) { map.removeLayer(pinMarker); pinMarker = null; }
      return;
    }
    if (!pinMarker) {
      pinMarker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({ className: '', html: '<div class="dest">📍</div>', iconSize: [30, 30], iconAnchor: [15, 28] })
      }).addTo(map);
    } else {
      pinMarker.setLatLng([pin.lat, pin.lng]);
    }
    pinMarker.unbindTooltip();
    if (pin.label) pinMarker.bindTooltip(pin.label, { direction: 'top', offset: [0, -30] });
    // Só a busca pede enquadramento: quem tocou no mapa já está olhando para o ponto, e
    // mover o mapa sob o dedo dele seria desorientador.
    if (center) { map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 16)); fitted = true; }
  };
  window.__pick = function (on) { pickMode = !!on; };
  map.on('click', function (e) {
    if (!pickMode || !window.ReactNativeWebView) return;
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ type: 'maptap', lat: e.latlng.lat, lng: e.latlng.lng })
    );
  });
  // Recalcula o tamanho do mapa quando o container muda de dimensão (layout tardio
  // do WebView, rotação, tela cheia). Sem isso o Leaflet renderiza só um pedaço e
  // não recarrega os tiles ao arrastar.
  function fixSize() { map.invalidateSize(false); }
  window.addEventListener('resize', fixSize);
  if (window.ResizeObserver) {
    try { new ResizeObserver(fixSize).observe(document.getElementById('map')); } catch (e) {}
  }
  map.whenReady(fixSize);
  setTimeout(fixSize, 100);
  setTimeout(fixSize, 400);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ready');
</script>
</body>
</html>`;

/**
 * Ponto marcado à espera de confirmação: o toque no mapa ou o acerto escolhido na busca
 * de endereço. `center` enquadra o mapa nele — verdadeiro para a busca (o ponto pode
 * estar fora da tela), falso para o toque.
 */
export interface DestinationPin extends TrackPoint {
  label?: string;
  center?: boolean;
}

/** Rota planejada a desenhar. `path` já vem em `{lat,lng}` (transposto em shared/geo). */
export interface PlannedRoute {
  /** Identidade do traçado: quando muda, o mapa reenquadra o trajeto inteiro. */
  id: string;
  path: TrackPoint[];
  destination: TrackPoint & { label?: string };
  /** Traçado direto (provedor fora) — desenhado pontilhado, sem promessa de vias. */
  fallback: boolean;
}

export function AgentMap({
  track,
  showTrack = true,
  headingUp = false,
  heading = null,
  focus = null,
  route = null,
  pin = null,
  pickMode = false,
  onMapTap,
}: {
  track: TrackPoint[];
  /** Desenhar o RASTRO já percorrido (não confundir com `route`, o trajeto planejado). */
  showTrack?: boolean;
  headingUp?: boolean;
  heading?: number | null;
  /** Centralizar o mapa na posição do agente; `nonce` muda a cada acionamento. */
  focus?: { lat: number; lng: number; nonce: number } | null;
  route?: PlannedRoute | null;
  /** Destino candidato, ainda não confirmado. `null` remove o marcador. */
  pin?: DestinationPin | null;
  /** Habilita a escolha de destino por toque no mapa (Fase 6b). */
  pickMode?: boolean;
  onMapTap?: (point: TrackPoint) => void;
}) {
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);
  const focusNonceRef = useRef(0);
  // Enquadramento: contador que só avança quando a rota é OUTRA — reenviar a mesma
  // rota (re-render, `ready` do WebView) não pode mexer no zoom do agente.
  const routeIdRef = useRef<string | null>(null);
  const routeFitRef = useRef(0);
  const pinKeyRef = useRef<string | null>(null);

  const push = useCallback(() => {
    if (!readyRef.current) return;
    ref.current?.injectJavaScript(
      `window.__update(${JSON.stringify(track)}, ${showTrack}, ${headingUp}, ${
        typeof heading === 'number' ? heading : 'null'
      }); true;`,
    );
  }, [track, showTrack, headingUp, heading]);

  const pushRoute = useCallback(() => {
    if (!readyRef.current) return;
    const id = route?.id ?? null;
    if (id !== routeIdRef.current) {
      routeIdRef.current = id;
      routeFitRef.current += 1;
    }
    const points = route ? route.path.map((p) => [p.lat, p.lng]) : [];
    ref.current?.injectJavaScript(
      `window.__route(${JSON.stringify(points)}, ${JSON.stringify(route?.destination ?? null)}, ${
        route?.fallback ?? false
      }, ${routeFitRef.current}); true;`,
    );
  }, [route]);

  const pushPin = useCallback(() => {
    if (!readyRef.current) return;
    // O enquadramento só acontece quando o ponto é OUTRO: re-render (ou o `ready` do
    // WebView reenviando tudo) não pode roubar o zoom/centro que o agente ajustou.
    const key = pin ? `${pin.lat},${pin.lng}` : null;
    const moved = key !== pinKeyRef.current;
    pinKeyRef.current = key;
    ref.current?.injectJavaScript(
      `window.__pin(${JSON.stringify(pin)}, ${Boolean(pin?.center) && moved}); true;`,
    );
  }, [pin]);

  const pushPickMode = useCallback(() => {
    if (!readyRef.current) return;
    ref.current?.injectJavaScript(`window.__pick(${pickMode}); true;`);
  }, [pickMode]);

  // Centraliza quando o `nonce` do focus muda (evita recentralizar em cada render).
  const pushFocus = useCallback(() => {
    if (!readyRef.current || !focus || focus.nonce === focusNonceRef.current) return;
    focusNonceRef.current = focus.nonce;
    ref.current?.injectJavaScript(`window.__focus(${focus.lat}, ${focus.lng}); true;`);
  }, [focus]);

  useEffect(() => {
    push();
  }, [push]);

  useEffect(() => {
    pushFocus();
  }, [pushFocus]);

  useEffect(() => {
    pushRoute();
  }, [pushRoute]);

  useEffect(() => {
    pushPin();
  }, [pushPin]);

  useEffect(() => {
    pushPickMode();
  }, [pushPickMode]);

  const onMessage = (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === 'ready') {
      readyRef.current = true;
      push();
      pushFocus();
      pushRoute();
      pushPin();
      pushPickMode();
      return;
    }
    try {
      const message = JSON.parse(data) as { type?: string; lat?: number; lng?: number };
      if (
        message.type === 'maptap' &&
        typeof message.lat === 'number' &&
        typeof message.lng === 'number'
      ) {
        onMapTap?.({ lat: message.lat, lng: message.lng });
      }
    } catch {
      /* mensagem desconhecida do WebView — ignora */
    }
  };

  return (
    <WebView
      ref={ref}
      originWhitelist={['*']}
      source={{ html: HTML }}
      onMessage={onMessage}
      javaScriptEnabled
      domStorageEnabled
      style={{ flex: 1, backgroundColor: '#0b0f14' }}
    />
  );
}
