import Constants from 'expo-constants';

/**
 * Fallback secundário: `extra` do app.config.ts. A fonte PRIMÁRIA são as
 * `EXPO_PUBLIC_*` lidas direto de `process.env` (o `babel-preset-expo` as substitui
 * inline no bundle do cliente) — mais confiável que `extra`, que depende do `.env`
 * ser carregado na avaliação do app.config (instável neste monorepo).
 */
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string;
  mqttWsUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
};

/**
 * Em desenvolvimento, deriva o host da API/broker do MESMO IP em que o Metro
 * serve o bundle (`hostUri`, ex.: "192.168.0.30:8081"). Como API e broker rodam
 * no mesmo PC que o Metro, ao trocar de rede (escritório → casa) NADA precisa
 * ser editado — o app segue o IP do Metro automaticamente.
 *
 * Um valor explícito (EXPO_PUBLIC_API_URL / EXPO_PUBLIC_MQTT_WS_URL) tem
 * prioridade — use para túnel (4G / rede diferente do dashboard) ou produção.
 */
function metroHost(): string | null {
  const hostUri = (Constants.expoConfig as { hostUri?: string } | null)?.hostUri;
  if (typeof hostUri !== 'string') return null;
  const host = hostUri.split(':')[0];
  return host && host !== 'localhost' ? host : null;
}

const host = metroHost();

// Prioridade: EXPO_PUBLIC_* (inline pelo Babel) → extra (app.config) → host do Metro.
export const config = {
  apiUrl:
    process.env.EXPO_PUBLIC_API_URL ||
    extra.apiUrl ||
    (host ? `http://${host}:3000` : 'http://localhost:3000'),
  // O app publica via MQTT sobre WebSockets (compatível com React Native).
  mqttWsUrl:
    process.env.EXPO_PUBLIC_MQTT_WS_URL ||
    extra.mqttWsUrl ||
    (host ? `ws://${host}:9001` : 'ws://localhost:9001'),
  // Credencial estática do broker (HiveMQ Cloud). Vazias no dev local / on-prem,
  // onde o app cai na auth por JWT (ver connectMqtt em services/mqtt.ts).
  mqttUsername: process.env.EXPO_PUBLIC_MQTT_USERNAME || extra.mqttUsername,
  mqttPassword: process.env.EXPO_PUBLIC_MQTT_PASSWORD || extra.mqttPassword,
};
