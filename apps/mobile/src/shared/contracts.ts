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

export function agentPositionTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/posicao`;
}

export function agentMessageTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/mensagem`;
}

/** `operacao/{operationId}/broadcast` — central → todos os agentes da operação. */
export function operationBroadcastTopic(operationId: string): string {
  return `${TOPIC_ROOT}/${operationId}/broadcast`;
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
