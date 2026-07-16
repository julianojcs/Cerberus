/**
 * Espelho local dos contratos de `@cerberus/shared`.
 *
 * O app móvel fica FORA dos workspaces npm (particularidades do Metro bundler com
 * hoisting), então mantemos aqui uma cópia mínima da taxonomia de tópicos e do
 * formato de amostra de posição. Em produção, o ideal é consumir @cerberus/shared
 * publicado num registry privado ou configurar o Metro para resolvê-lo.
 * Mantenha em sincronia com packages/shared/src/{topics,schemas,constants}.ts.
 */

export const TOPIC_ROOT = 'operacao';
/** Segmento de equipe (sem acento — identificador de rede). */
export const TEAM_SEGMENT = 'equipe';

export function agentPositionTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/posicao`;
}

export function agentMessageTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/mensagem`;
}

/** `operacao/{operationId}/agente/{agentId}/inbox` — DM da central para o agente. */
export function agentInboxTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/inbox`;
}

/** `operacao/{operationId}/agente/{agentId}/status` — presença do agente. */
export function agentStatusTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/status`;
}

/**
 * Presença publicada no canal `status` (retida): `online: true` ao conectar e
 * `online: false` na saída limpa ou pelo LWT (o broker publica se o app sumir).
 * Sem `agentId` no corpo — a identidade vem do tópico.
 */
export interface AgentStatus {
  online: boolean;
}

/** `operacao/{operationId}/broadcast` — central → todos os agentes da operação. */
export function operationBroadcastTopic(operationId: string): string {
  return `${TOPIC_ROOT}/${operationId}/broadcast`;
}

/** `operacao/{operationId}/equipe/{teamId}/broadcast` — mensagem aos membros da equipe. */
export function teamBroadcastTopic(operationId: string, teamId: string): string {
  return `${TOPIC_ROOT}/${operationId}/${TEAM_SEGMENT}/${teamId}/broadcast`;
}

export interface PositionSample {
  lat: number;
  lng: number;
  accuracy?: number;
  altitude?: number;
  speed?: number | null;
  heading?: number | null;
  battery?: number;
  activity?: string;
  /** ISO 8601 — timestamp de captura no dispositivo. */
  capturedAt: string;
}
