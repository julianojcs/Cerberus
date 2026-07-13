import mqtt, { type MqttClient } from 'mqtt';
import {
  operationWildcardTopic,
  parseAgentTopic,
  AgentChannel,
  positionSampleSchema,
  type PositionSample,
} from '@cerberus/shared';

const MQTT_WS_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL ?? 'ws://localhost:9001';
// Credencial estática do broker (HiveMQ Cloud, MVP). Sem estas, apresenta o JWT
// ao broker (base para ACL no on-prem EMQX/Mosquitto). Ver mqtt-multitenant.md.
const MQTT_USERNAME = process.env.NEXT_PUBLIC_MQTT_USERNAME;
const MQTT_PASSWORD = process.env.NEXT_PUBLIC_MQTT_PASSWORD;

export interface LivePosition extends PositionSample {
  operationId: string;
  agentId: string;
}

/**
 * Conecta ao broker via MQTT sobre WebSockets e assina `operacao/{id}/#`.
 * A plotagem em tempo real vem direto do barramento — não passa pelo banco,
 * evitando gargalo na camada de persistência (conforme a especificação).
 */
export function subscribeToOperation(
  operationId: string,
  onPosition: (pos: LivePosition) => void,
  token?: string,
  onStatus?: (connected: boolean) => void,
): () => void {
  const client: MqttClient = mqtt.connect(MQTT_WS_URL, {
    // HiveMQ Cloud (MVP) usa credencial estática; on-prem (EMQX/Mosquitto) valida
    // o JWT apresentado como 'jwt' + token. Escolha por ambiente (12-factor).
    username: MQTT_USERNAME || (token ? 'jwt' : undefined),
    password: MQTT_USERNAME ? MQTT_PASSWORD : token,
    reconnectPeriod: 2000,
  });

  // O status do barramento reflete a conexão REAL ao broker (não a chegada de
  // posições) — um agente parado publica raramente, mas a conexão está viva.
  client.on('connect', () => {
    onStatus?.(true);
    client.subscribe(operationWildcardTopic(operationId), { qos: 1 });
  });
  client.on('close', () => onStatus?.(false));
  client.on('offline', () => onStatus?.(false));

  client.on('message', (topic, payload) => {
    const parsed = parseAgentTopic(topic);
    if (!parsed || parsed.channel !== AgentChannel.POSICAO) return;
    try {
      const sample = positionSampleSchema.parse(JSON.parse(payload.toString()));
      onPosition({ ...sample, operationId: parsed.operationId, agentId: parsed.agentId });
    } catch {
      /* payload inválido — ignora */
    }
  });

  return () => {
    client.end(true);
  };
}
