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
<style>html,body,#map{height:100%;margin:0;background:#0b0f14}</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([-19.9319, -43.9386], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  var line = L.polyline([], { color: '#c1121f', weight: 4, opacity: 0.85 }).addTo(map);
  var marker = null;
  var fitted = false;
  window.__update = function (track, showRoute) {
    if (!track || !track.length) return;
    var latlngs = track.map(function (p) { return [p.lat, p.lng]; });
    // O marcador (posição atual) fica sempre visível; a rota liga/desliga.
    line.setLatLngs(showRoute ? latlngs : []);
    var last = latlngs[latlngs.length - 1];
    if (!marker) {
      marker = L.circleMarker(last, { radius: 8, color: '#fff', weight: 2, fillColor: '#c1121f', fillOpacity: 1 }).addTo(map);
    } else {
      marker.setLatLng(last);
    }
    if (!fitted) { map.setView(last, 16); fitted = true; }
    else { map.panTo(last); }
  };
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ready');
</script>
</body>
</html>`;

export function AgentMap({
  track,
  showRoute = true,
}: {
  track: TrackPoint[];
  showRoute?: boolean;
}) {
  const ref = useRef<WebView>(null);
  const readyRef = useRef(false);

  const push = useCallback(() => {
    if (!readyRef.current) return;
    ref.current?.injectJavaScript(`window.__update(${JSON.stringify(track)}, ${showRoute}); true;`);
  }, [track, showRoute]);

  useEffect(() => {
    push();
  }, [push]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data === 'ready') {
      readyRef.current = true;
      push();
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
