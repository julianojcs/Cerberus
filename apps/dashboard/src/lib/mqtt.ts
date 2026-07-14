import mqtt, { type MqttClient } from 'mqtt';
import {
  operationWildcardTopic,
  parseAgentTopic,
  parseTeamTopic,
  AgentChannel,
  positionSampleSchema,
  type PositionSample,
} from '@cerberus/shared';

const MQTT_WS_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL ?? 'ws://localhost:9001';

export interface LivePosition extends PositionSample {
  operationId: string;
  agentId: string;
}

/** Escopo de uma mensagem de chat recebida ao vivo. */
export type ChatScope = 'equipe' | 'dm';

/** Mensagem E2EE recebida ao vivo (equipe ou DM). O conteúdo vem cifrado. */
export interface IncomingMessage {
  scope: ChatScope;
  teamId?: string; // scope === 'equipe'
  recipientId?: string; // scope === 'dm' (agente destino)
  senderId: string;
  type: string;
  ciphertext?: string;
  text?: string;
  capturedAt: string;
}

interface RawChat {
  senderId: string;
  type: string;
  ciphertext?: string;
  text?: string;
  capturedAt: string;
}

function deliverMessage(
  payload: Uint8Array,
  onMessage: (m: IncomingMessage) => void,
  extra: { scope: ChatScope; teamId?: string; recipientId?: string },
): void {
  try {
    const raw = JSON.parse(payload.toString()) as RawChat;
    onMessage({
      scope: extra.scope,
      teamId: extra.teamId,
      recipientId: extra.recipientId,
      senderId: raw.senderId,
      type: raw.type,
      ciphertext: raw.ciphertext,
      text: raw.text,
      capturedAt: raw.capturedAt,
    });
  } catch {
    /* payload inválido — ignora */
  }
}

/**
 * Conecta ao broker via MQTT sobre WebSockets e assina `operacao/{id}/#`.
 * A plotagem em tempo real vem direto do barramento — não passa pelo banco,
 * evitando gargalo na camada de persistência (conforme a especificação).
 *
 * `onMessage` (opcional) entrega, ao vivo, as mensagens de EQUIPE
 * (`operacao/{op}/equipe/{tid}/broadcast`) e de DM/inbox
 * (`operacao/{op}/agente/{agentId}/inbox`) — cifradas; o cliente decifra.
 */
export function subscribeToOperation(
  operationId: string,
  onPosition: (pos: LivePosition) => void,
  token?: string,
  onStatus?: (connected: boolean) => void,
  onMessage?: (m: IncomingMessage) => void,
): () => void {
  const client: MqttClient = mqtt.connect(MQTT_WS_URL, {
    // O token JWT é apresentado ao broker (base para ACL em produção EMQX/Mosquitto).
    username: token ? 'jwt' : undefined,
    password: token,
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
    const agentTopic = parseAgentTopic(topic);
    // Posição do agente (telemetria ao vivo).
    if (agentTopic && agentTopic.channel === AgentChannel.POSICAO) {
      try {
        const sample = positionSampleSchema.parse(JSON.parse(payload.toString()));
        onPosition({ ...sample, operationId: agentTopic.operationId, agentId: agentTopic.agentId });
      } catch {
        /* payload inválido — ignora */
      }
      return;
    }
    if (!onMessage) return;
    // DM (inbox do agente) — `recipientId` = agente do tópico.
    if (agentTopic && agentTopic.channel === AgentChannel.INBOX) {
      deliverMessage(payload, onMessage, { scope: 'dm', recipientId: agentTopic.agentId });
      return;
    }
    // Mensagem de equipe.
    const teamTopic = parseTeamTopic(topic);
    if (teamTopic && teamTopic.channel === 'broadcast') {
      deliverMessage(payload, onMessage, { scope: 'equipe', teamId: teamTopic.teamId });
    }
  });

  return () => {
    client.end(true);
  };
}
