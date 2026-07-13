import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';
import {
  agentPositionTopic,
  operationBroadcastTopic,
  type PositionSample,
} from '../shared/contracts';
import { openMessage } from '../shared/e2ee';
import { flushOutbox, queuePosition } from './outbox';

let client: MqttClient | null = null;

/** Diretiva recebida da central, com o texto já decifrado (ou em claro se sistema). */
export interface BroadcastMessage {
  senderId: string;
  type: string;
  text: string;
  capturedAt: string;
}

/** Payload cru no canal: broadcast E2EE (`ciphertext`) ou sistema em claro (`text`). */
interface RawBroadcast {
  senderId: string;
  type: string;
  text?: string;
  ciphertext?: string;
  capturedAt: string;
}

/** Identidade do agente para decifrar o envelope E2EE (id + chave secreta local). */
export interface BroadcastIdentity {
  myId: string;
  secretKey: string | null;
}

type BroadcastListener = (message: BroadcastMessage) => void;
const broadcastListeners = new Set<BroadcastListener>();
let broadcastOperationId: string | null = null;
let broadcastIdentity: BroadcastIdentity = { myId: '', secretKey: null };

/** Decifra o broadcast E2EE ou repassa a mensagem de sistema em claro (alertas). */
function resolveText(m: RawBroadcast): string | null {
  if (typeof m.ciphertext === 'string' && m.ciphertext.length > 0) {
    if (!broadcastIdentity.secretKey) return null; // sem chave local para decifrar
    return openMessage(m.ciphertext, broadcastIdentity.myId, broadcastIdentity.secretKey);
  }
  return typeof m.text === 'string' ? m.text : null;
}

function handleIncoming(topic: string, payload: Uint8Array): void {
  if (!broadcastOperationId || topic !== operationBroadcastTopic(broadcastOperationId)) return;
  try {
    const m = JSON.parse(Buffer.from(payload).toString()) as RawBroadcast;
    const text = resolveText(m);
    if (text === null) return; // cifrado e não decifrável por este agente — ignora
    const message: BroadcastMessage = {
      senderId: m.senderId,
      type: m.type,
      text,
      capturedAt: m.capturedAt,
    };
    for (const listener of broadcastListeners) listener(message);
  } catch {
    /* payload inválido — ignora */
  }
}

/**
 * Assina o canal de broadcast da operação (central → agentes). O menor privilégio
 * da regra mqtt-multitenant: o agente ouve apenas `operacao/{opId}/broadcast`. A
 * `identity` permite decifrar o envelope E2EE destinado a este agente.
 */
export function subscribeBroadcast(
  operationId: string,
  identity: BroadcastIdentity,
  listener: BroadcastListener,
): () => void {
  broadcastOperationId = operationId;
  broadcastIdentity = identity;
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
