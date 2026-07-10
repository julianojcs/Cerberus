/**
 * Taxonomia de tópicos MQTT do Cerberus — FONTE ÚNICA DE VERDADE.
 *
 * Estrutura (conforme especificação técnica): `operacao/{operationId}/agente/{agentId}/...`
 * A hierarquia é a base das ACLs de rede: o agente só publica no próprio subtópico;
 * a central (dashboard) assina `operacao/{operationId}/#` dentro do seu escopo.
 */

export const TOPIC_ROOT = 'operacao';

/** Sufixos de canal por agente. */
export const AgentChannel = {
  POSICAO: 'posicao',
  MENSAGEM: 'mensagem',
  STATUS: 'status',
} as const;
export type AgentChannel = (typeof AgentChannel)[keyof typeof AgentChannel];

/** `operacao/{operationId}/agente/{agentId}/posicao` */
export function agentPositionTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/${AgentChannel.POSICAO}`;
}

/** `operacao/{operationId}/agente/{agentId}/mensagem` */
export function agentMessageTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/${AgentChannel.MENSAGEM}`;
}

/** `operacao/{operationId}/agente/{agentId}/status` */
export function agentStatusTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/${AgentChannel.STATUS}`;
}

/** `operacao/{operationId}/broadcast` — central → todos os agentes da operação. */
export function operationBroadcastTopic(operationId: string): string {
  return `${TOPIC_ROOT}/${operationId}/broadcast`;
}

/** Wildcard de escuta da central para uma operação inteira: `operacao/{operationId}/#`. */
export function operationWildcardTopic(operationId: string): string {
  return `${TOPIC_ROOT}/${operationId}/#`;
}

/**
 * Wildcard que a PONTE da API assina para persistir a telemetria de TODAS as
 * operações: `operacao/+/agente/+/#`.
 */
export function bridgeIngestTopic(): string {
  return `${TOPIC_ROOT}/+/agente/+/#`;
}

export interface ParsedAgentTopic {
  operationId: string;
  agentId: string;
  channel: string;
}

/**
 * Faz o parse de um tópico de agente. Retorna `null` se não casar com o padrão
 * `operacao/{operationId}/agente/{agentId}/{channel}`.
 */
export function parseAgentTopic(topic: string): ParsedAgentTopic | null {
  const parts = topic.split('/');
  // ['operacao', operationId, 'agente', agentId, channel]
  if (parts.length !== 5) return null;
  const [root, operationId, agente, agentId, channel] = parts;
  if (root !== TOPIC_ROOT || agente !== 'agente') return null;
  if (!operationId || !agentId || !channel) return null;
  return { operationId, agentId, channel };
}
