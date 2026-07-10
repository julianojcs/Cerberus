import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';
import { agentPositionTopic, type PositionSample } from '../shared/contracts';
import { flushOutbox, queuePosition } from './outbox';

let client: MqttClient | null = null;

/**
 * Conecta ao barramento MQTT (sobre WebSockets) usando o JWT como credencial.
 * Em produção, o broker (EMQX/Mosquitto) valida o token e aplica as ACLs de
 * tópico: o agente só publica no próprio canal.
 */
export function connectMqtt(token: string, agentId: string): MqttClient {
  if (client?.connected) return client;

  client = mqtt.connect(config.mqttWsUrl, {
    clientId: `agente_${agentId}_${Date.now()}`,
    username: 'jwt',
    password: token,
    reconnectPeriod: 3000,
    clean: true,
  });

  client.on('connect', () => {
    // Ao reconectar, descarrega o buffer offline (resiliência de rede).
    void flushOutbox(publishNow);
  });

  return client;
}

export function isConnected(): boolean {
  return Boolean(client?.connected);
}

/** Publica imediatamente (usado pelo flush do outbox). */
function publishNow(operationId: string, agentId: string, sample: PositionSample): boolean {
  if (!client?.connected) return false;
  client.publish(agentPositionTopic(operationId, agentId), JSON.stringify(sample), { qos: 1 });
  return true;
}

/**
 * Publica uma posição. Se offline (zona de sombra), enfileira no outbox local
 * para descarga assíncrona quando a conectividade voltar.
 */
export async function publishPosition(
  operationId: string,
  agentId: string,
  sample: PositionSample,
): Promise<void> {
  if (!publishNow(operationId, agentId, sample)) {
    await queuePosition({ operationId, agentId, sample });
  }
}

export function disconnectMqtt(): void {
  client?.end(true);
  client = null;
}
