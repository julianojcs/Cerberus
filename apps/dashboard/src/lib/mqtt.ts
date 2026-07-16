import mqtt, { type MqttClient } from 'mqtt';
import {
  bridgeIngestTopic,
  operationWildcardTopic,
  parseAgentTopic,
  parseTeamTopic,
  AgentChannel,
  agentStatusSchema,
  positionSampleSchema,
  type PositionSample,
} from '@cerberus/shared';

const MQTT_WS_URL = process.env.NEXT_PUBLIC_MQTT_WS_URL ?? 'ws://localhost:9001';
// Credencial ESTÁTICA do broker gerenciado (HiveMQ Cloud free — não faz auth por
// JWT). Quando definida, tem prioridade; senão cai no jwt+token (on-prem
// EMQX/Mosquitto com ACL por claims). Ver .claude/rules/mqtt-multitenant.md.
const MQTT_USERNAME = process.env.NEXT_PUBLIC_MQTT_USERNAME;
const MQTT_PASSWORD = process.env.NEXT_PUBLIC_MQTT_PASSWORD;

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
  mediaRef?: string; // type === 'media'
  capturedAt: string;
}

interface RawChat {
  senderId: string;
  type: string;
  ciphertext?: string;
  text?: string;
  mediaRef?: string;
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
      mediaRef: raw.mediaRef,
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
  /**
   * Presença de um AGENTE (canal `status`) — não confundir com `onStatus`, que é a
   * conexão do próprio dashboard ao barramento. Chega retida ao assinar e é
   * atualizada pelo LWT quando o agente some.
   */
  onPresence?: (agentId: string, online: boolean) => void,
): () => void {
  const client: MqttClient = mqtt.connect(MQTT_WS_URL, {
    // Credencial estática (broker gerenciado) quando configurada; senão o JWT é
    // apresentado ao broker (base para ACL em produção EMQX/Mosquitto).
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
    // Presença do agente (retida): `online` explícito vindo do app ou do LWT.
    if (agentTopic && agentTopic.channel === AgentChannel.STATUS) {
      try {
        const s = agentStatusSchema.parse(JSON.parse(payload.toString()));
        onPresence?.(agentTopic.agentId, s.online);
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

/**
 * Assinatura GLOBAL (console do SuperAdmin): UMA conexão que assina todas as
 * operações (`operacao/+/agente/+/#`) e entrega só as posições ao vivo. O SA
 * transcende o escopo por design (ver isSuperAdmin) e a credencial estática do
 * broker já é privilegiada — então o mapa global vê tudo com 1 conexão, em vez
 * de N (uma por operação). Só posições; ignora chat/status.
 */
export function subscribeAllOperations(
  onPosition: (pos: LivePosition) => void,
  token?: string,
  onStatus?: (connected: boolean) => void,
): () => void {
  const client: MqttClient = mqtt.connect(MQTT_WS_URL, {
    username: MQTT_USERNAME || (token ? 'jwt' : undefined),
    password: MQTT_USERNAME ? MQTT_PASSWORD : token,
    reconnectPeriod: 2000,
  });

  client.on('connect', () => {
    onStatus?.(true);
    client.subscribe(bridgeIngestTopic(), { qos: 1 });
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
