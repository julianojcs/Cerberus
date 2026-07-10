import Constants from 'expo-constants';

/** Configuração injetada por ambiente (app.config.ts -> extra). */
const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string;
  mqttWsUrl?: string;
};

export const config = {
  apiUrl: extra.apiUrl ?? 'http://localhost:3000',
  // O app publica via MQTT sobre WebSockets (compatível com React Native).
  mqttWsUrl: extra.mqttWsUrl ?? 'ws://localhost:9001',
};
