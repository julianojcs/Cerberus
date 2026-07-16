/**
 * Taxonomia de tópicos MQTT do Cerberus — FONTE ÚNICA DE VERDADE.
 *
 * Estrutura (conforme especificação técnica): `operacao/{operationId}/agente/{agentId}/...`
 * A hierarquia é a base das ACLs de rede: o agente só publica no próprio subtópico;
 * a central (dashboard) assina `operacao/{operationId}/#` dentro do seu escopo.
 */

export const TOPIC_ROOT = 'operacao';
/** Segmento de equipe (sem acento — identificador de rede, não texto de UI). */
export const TEAM_SEGMENT = 'equipe';

/** Sufixos de canal por agente. */
export const AgentChannel = {
  POSICAO: 'posicao',
  MENSAGEM: 'mensagem',
  STATUS: 'status',
  /** Caixa de entrada do agente (DM da central → agente). */
  INBOX: 'inbox',
  /** Comando da central → agente (controle; ver AgentCommandType). */
  COMANDO: 'comando',
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

/** `operacao/{operationId}/agente/{agentId}/inbox` — DM da central para um agente. */
export function agentInboxTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/${AgentChannel.INBOX}`;
}

/**
 * `operacao/{operationId}/agente/{agentId}/comando` — central → UM agente (controle).
 * Fica no subtópico do próprio agente, então respeita o menor privilégio: o agente já
 * assina `operacao/{opId}/agente/{agentId}/#` e não precisa de acesso novo.
 */
export function agentCommandTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/${AgentChannel.COMANDO}`;
}

/** `operacao/{operationId}/broadcast` — central → todos os agentes da operação. */
export function operationBroadcastTopic(operationId: string): string {
  return `${TOPIC_ROOT}/${operationId}/broadcast`;
}

/**
 * `operacao/{operationId}/equipe/{teamId}/broadcast` — mensagem para os membros de
 * uma equipe. Isolamento na REDE (só quem assina o tópico recebe) + na CRIPTO (o
 * envelope E2EE é selado só para os membros).
 */
export function teamBroadcastTopic(operationId: string, teamId: string): string {
  return `${TOPIC_ROOT}/${operationId}/${TEAM_SEGMENT}/${teamId}/broadcast`;
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

export interface ParsedTeamTopic {
  operationId: string;
  teamId: string;
  channel: string;
}

/**
 * Faz o parse de um tópico de equipe. Retorna `null` se não casar com o padrão
 * `operacao/{operationId}/equipe/{teamId}/{channel}`. Separado de `parseAgentTopic`
 * para não afetar o parsing de agente (a ponte de ingest continua só com agentes).
 */
export function parseTeamTopic(topic: string): ParsedTeamTopic | null {
  const parts = topic.split('/');
  // ['operacao', operationId, 'equipe', teamId, channel]
  if (parts.length !== 5) return null;
  const [root, operationId, equipe, teamId, channel] = parts;
  if (root !== TOPIC_ROOT || equipe !== TEAM_SEGMENT) return null;
  if (!operationId || !teamId || !channel) return null;
  return { operationId, teamId, channel };
}
