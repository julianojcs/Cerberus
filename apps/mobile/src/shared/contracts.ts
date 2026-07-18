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

/**
 * `operacao/{operationId}/agente/{agentId}/comando` — central → ESTE agente (controle).
 * Fica no subtópico do próprio agente, que ele já assina (menor privilégio).
 */
export function agentCommandTopic(operationId: string, agentId: string): string {
  return `${TOPIC_ROOT}/${operationId}/agente/${agentId}/comando`;
}

/** Comandos de CONTROLE da central (não é chat, não é E2EE, não vai pro histórico). */
export const AgentCommandType = {
  /** Pede uma posição fresca AGORA (o GPS hiberna parado; o Doze adia o heartbeat). */
  REQUEST_FIX: 'request_fix',
  /**
   * Uma rota foi atribuída a este agente. O comando carrega APENAS o `routeId` — o
   * traçado vem por HTTPS (`GET /operations/:id/routes/:routeId`), porque um trajeto
   * com instruções passa fácil de dezenas de KB e estouraria o canal de controle.
   */
  ROUTE_ASSIGN: 'route_assign',
  /** A rota ativa foi cancelada. Sem `routeId` ⇒ cancela o que estiver ativo. */
  ROUTE_CANCEL: 'route_cancel',
} as const;
export type AgentCommandType = (typeof AgentCommandType)[keyof typeof AgentCommandType];

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

// --- Navegação por rota (issue #131) ---

/**
 * Manobra de um passo. Vocabulário PRÓPRIO do Cerberus (não é o do OSRM). No app serve
 * só para escolher o ícone: a frase já vem redigida em `RouteStep.instruction`.
 */
export const RouteManeuver = {
  DEPART: 'depart',
  ARRIVE: 'arrive',
  STRAIGHT: 'straight',
  TURN_LEFT: 'turn_left',
  TURN_RIGHT: 'turn_right',
  SLIGHT_LEFT: 'slight_left',
  SLIGHT_RIGHT: 'slight_right',
  SHARP_LEFT: 'sharp_left',
  SHARP_RIGHT: 'sharp_right',
  UTURN: 'uturn',
  ROUNDABOUT: 'roundabout',
  MERGE: 'merge',
  FORK_LEFT: 'fork_left',
  FORK_RIGHT: 'fork_right',
  RAMP: 'ramp',
} as const;
export type RouteManeuver = (typeof RouteManeuver)[keyof typeof RouteManeuver];

/** Quem definiu o destino: a central despachou, ou o próprio agente escolheu no app. */
export const RouteSource = {
  CENTRAL: 'central',
  AGENT: 'agent',
} as const;
export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource];

/** Raio (m) do destino que caracteriza a chegada — espelha o valor do servidor. */
export const ROUTE_ARRIVAL_METERS = 30;

/**
 * Distância (m) do traçado a partir da qual o agente está FORA da rota. O app NÃO
 * dispara recálculo com isto (quem detecta desvio é a ponte de ingest, que empurra a
 * rota nova como um `route_assign`) — serve apenas para avisar o agente na tela.
 */
export const ROUTE_DEVIATION_METERS = 50;

/** Um passo (manobra) do trajeto, com a instrução JÁ redigida em pt-BR pelo servidor. */
export interface RouteStep {
  /** Pronta para exibir/falar. O app NUNCA traduz nem reescreve. */
  instruction: string;
  maneuver: RouteManeuver;
  streetName?: string;
  distanceMeters: number;
  durationSec: number;
  /** Onde a manobra acontece: `[lng, lat]` (GeoJSON) — inverter antes de usar no mapa. */
  location: [number, number];
}

/** Rota serializada pela API — é o que o app baixa e segue (offline, depois de baixada). */
export interface RouteInfo {
  id: string;
  operationId: string;
  agentId: string;
  source: RouteSource;
  /** `ativa` | `concluida` | `cancelada` | `substituida`. */
  status: string;
  /** Sempre `driving` hoje (decisão de produto da issue #131). */
  profile: string;
  destination: { lat: number; lng: number; label?: string };
  /** Traçado completo em `[[lng, lat], …]` — GeoJSON, NÃO é a ordem do Leaflet. */
  geometry: [number, number][];
  steps: RouteStep[];
  distanceMeters: number;
  durationSec: number;
  /**
   * `true` quando o provedor de rotas estava fora e o traçado é a LINHA RETA
   * origem→destino. Nesse caso não há manobra real: o app degrada para rumo +
   * distância e não fala instrução nenhuma.
   */
  fallback: boolean;
  /** Id da rota que esta substituiu (recálculo por desvio feito pelo servidor). */
  recalculatedFrom?: string;
  createdAt: string;
  createdBy?: string;
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
