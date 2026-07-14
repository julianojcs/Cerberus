import Constants from 'expo-constants';

/** Configuração injetada por ambiente (app.config.ts -> extra). */
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

export const config = {
  apiUrl: extra.apiUrl ?? (host ? `http://${host}:3000` : 'http://localhost:3000'),
  // O app publica via MQTT sobre WebSockets (compatível com React Native).
  mqttWsUrl: extra.mqttWsUrl ?? (host ? `ws://${host}:9001` : 'ws://localhost:9001'),
  // Credencial estática do broker (HiveMQ Cloud). Vazia ⇒ conecta com jwt+token.
  mqttUsername: extra.mqttUsername,
  mqttPassword: extra.mqttPassword,
};
