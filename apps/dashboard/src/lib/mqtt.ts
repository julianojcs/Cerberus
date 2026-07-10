import mqtt, { type MqttClient } from 'mqtt';
import {
  operationWildcardTopic,
  parseAgentTopic,
  AgentChannel,
  positionSampleSchema,
  type PositionSample,
} from '@cerberus/shared';

const MQTT_WS_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL ?? 'ws://localhost:9001';

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
): () => void {
  const client: MqttClient = mqtt.connect(MQTT_WS_URL, {
    // O token JWT é apresentado ao broker (base para ACL em produção EMQX/Mosquitto).
    username: token ? 'jwt' : undefined,
    password: token,
    reconnectPeriod: 2000,
  });

  client.on('connect', () => {
    client.subscribe(operationWildcardTopic(operationId), { qos: 1 });
  });

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
