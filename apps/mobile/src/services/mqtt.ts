import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';
import {
  agentPositionTopic,
  operationBroadcastTopic,
  type PositionSample,
} from '../shared/contracts';
import { flushOutbox, queuePosition } from './outbox';

let client: MqttClient | null = null;

/** Diretiva recebida da central (canal broadcast da operação). */
export interface BroadcastMessage {
  senderId: string;
  type: string;
  text: string;
  capturedAt: string;
}

type BroadcastListener = (message: BroadcastMessage) => void;
const broadcastListeners = new Set<BroadcastListener>();
let broadcastOperationId: string | null = null;

function handleIncoming(topic: string, payload: Uint8Array): void {
  if (!broadcastOperationId || topic !== operationBroadcastTopic(broadcastOperationId)) return;
  try {
    const m = JSON.parse(Buffer.from(payload).toString()) as BroadcastMessage;
    if (m && typeof m.text === 'string') {
      for (const listener of broadcastListeners) listener(m);
    }
  } catch {
    /* payload inválido — ignora */
  }
}

/**
 * Assina o canal de broadcast da operação (central → agentes). O menor privilégio
 * da regra mqtt-multitenant: o agente ouve apenas `operacao/{opId}/broadcast`.
 */
export function subscribeBroadcast(operationId: string, listener: BroadcastListener): () => void {
  broadcastOperationId = operationId;
  broadcastListeners.add(listener);
  if (client?.connected) {
    client.subscribe(operationBroadcastTopic(operationId), { qos: 1 });
  }
  return () => {
    broadcastListeners.delete(listener);
  };
}

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
    // Re-assina o broadcast (sobrevive a reconexões).
    if (broadcastOperationId) {
      client?.subscribe(operationBroadcastTopic(broadcastOperationId), { qos: 1 });
    }
  });

  // Sem este handler as falhas de conexão ficam silenciosas. Loga o motivo (host
  // inalcançável, WS recusado, etc.) — visível no Metro/debugger. O mqtt.js segue
  // tentando reconectar sozinho (reconnectPeriod).
  client.on('error', (err) => {
    console.warn(`[mqtt] falha de conexão em ${config.mqttWsUrl}:`, err?.message ?? err);
  });

  client.on('message', handleIncoming);

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
