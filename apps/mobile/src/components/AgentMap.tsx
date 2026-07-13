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
<style>html,body,#map{height:100%;margin:0;background:#0b0f14}</style>
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
  var line = L.polyline([], { color: '#c1121f', weight: 4, opacity: 0.85 }).addTo(map);
  var meMarker = null;
  var fitted = false;
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

export function AgentMap({
  track,
  showRoute = true,
  headingUp = false,
  heading = null,
  focus = null,
}: {
  track: TrackPoint[];
  showRoute?: boolean;
  headingUp?: boolean;
  heading?: number | null;
  /** Centralizar o mapa na posição do agente; `nonce` muda a cada acionamento. */
  focus?: { lat: number; lng: number; nonce: number } | null;
}) {
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);
  const focusNonceRef = useRef(0);

  const push = useCallback(() => {
    if (!readyRef.current) return;
    ref.current?.injectJavaScript(
      `window.__update(${JSON.stringify(track)}, ${showRoute}, ${headingUp}, ${
        typeof heading === 'number' ? heading : 'null'
      }); true;`,
    );
  }, [track, showRoute, headingUp, heading]);

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

  const onMessage = (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data === 'ready') {
      readyRef.current = true;
      push();
      pushFocus();
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
