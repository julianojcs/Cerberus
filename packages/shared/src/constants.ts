/**
 * Constantes de domínio do Cerberus — fonte única de verdade compartilhada
 * entre API, dashboard e app móvel.
 */

/** Papéis de acesso (RBAC). */
export const Role = {
  /** Superusuário global: transcende o RBAC e o escopo de operação (gestão total). */
  SUPERADMIN: 'superadmin',
  /** Administração central: enxerga operações e decifra conteúdo E2EE. */
  ADMIN: 'admin',
  /** Agente de campo: publica telemetria apenas no próprio canal. */
  AGENTE: 'agente',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Tipos de operação suportados. */
export const OperationType = {
  MANDADO: 'mandado', // busca e apreensão
  ESCOLTA: 'escolta', // comboio de viaturas
  PROTECAO: 'protecao', // proteção de dignitários
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

/** Ciclo de vida de uma operação. */
export const OperationStatus = {
  PLANEJADA: 'planejada',
  ATIVA: 'ativa',
  ENCERRADA: 'encerrada',
} as const;
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];

/** Formato de uma zona (geofence). Sem `shape` ⇒ círculo (retrocompat). */
export const GeofenceShape = {
  CIRCLE: 'circle',
  RECTANGLE: 'rectangle',
  POLYGON: 'polygon',
} as const;
export type GeofenceShape = (typeof GeofenceShape)[keyof typeof GeofenceShape];

/** Qual transição de uma zona dispara alerta (Fase 5b). Padrão: ambas. */
export const GeofenceTrigger = {
  ENTER: 'enter',
  EXIT: 'exit',
  BOTH: 'both',
} as const;
export type GeofenceTrigger = (typeof GeofenceTrigger)[keyof typeof GeofenceTrigger];

/** Severidade/prioridade de uma zona → cor do alerta + ordenação (Fase 5b). */
export const GeofenceSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type GeofenceSeverity = (typeof GeofenceSeverity)[keyof typeof GeofenceSeverity];

/** Peso de ordenação por severidade (crítica primeiro). */
export const GEOFENCE_SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Estado de movimento reportado pelo reconhecimento de atividade do dispositivo
 * (acelerômetro/giroscópio). Dirige o gerenciamento dinâmico de energia.
 */
export const ActivityType = {
  STILL: 'still',
  ON_FOOT: 'on_foot',
  WALKING: 'walking',
  RUNNING: 'running',
  IN_VEHICLE: 'in_vehicle',
  ON_BICYCLE: 'on_bicycle',
  UNKNOWN: 'unknown',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

/**
 * Comandos da central para um agente (canal `comando`). Não confundir com mensagem
 * tática: comando é CONTROLE (não é E2EE, não vira chat, não é persistido no histórico).
 */
export const AgentCommandType = {
  /**
   * Pede uma posição fresca AGORA. Existe porque o GPS hiberna quando o agente está
   * parado (heartbeat de 5 min) e o Android pode adiar esse alarme por muito mais
   * (Doze) — sem isto a central não tem como forçar uma atualização.
   */
  REQUEST_FIX: 'request_fix',
  /**
   * Uma rota foi atribuída ao agente. O comando carrega apenas o `routeId` — o
   * traçado completo é buscado por HTTPS (`GET /operations/:id/routes/:routeId`).
   * Mandar a geometria aqui estouraria o payload do canal de controle: um trajeto
   * com `overview=full` + instruções passa fácil de dezenas de KB.
   */
  ROUTE_ASSIGN: 'route_assign',
  /** A rota ativa foi cancelada pela central. Sem `routeId` ⇒ cancela o que estiver ativo. */
  ROUTE_CANCEL: 'route_cancel',
} as const;
export type AgentCommandType = (typeof AgentCommandType)[keyof typeof AgentCommandType];

/**
 * Ciclo de vida de uma rota atribuída a um agente.
 *
 * `SUBSTITUIDA` existe por causa do recálculo por desvio: a rota antiga não foi
 * cancelada pelo operador nem concluída pelo agente — ela foi trocada por uma nova.
 * Distinguir isso de `CANCELADA` preserva o histórico do que realmente aconteceu.
 */
export const RouteStatus = {
  ATIVA: 'ativa',
  CONCLUIDA: 'concluida',
  CANCELADA: 'cancelada',
  SUBSTITUIDA: 'substituida',
} as const;
export type RouteStatus = (typeof RouteStatus)[keyof typeof RouteStatus];

/** Quem definiu o destino: a central despachou, ou o próprio agente escolheu no app. */
export const RouteSource = {
  CENTRAL: 'central',
  AGENT: 'agent',
} as const;
export type RouteSource = (typeof RouteSource)[keyof typeof RouteSource];

/**
 * Perfil de deslocamento do cálculo de rota. **Só `driving`** por decisão de produto
 * (issue #131): rota a pé está fora de escopo e de bicicleta nunca existirá. O enum
 * existe para o contrato ficar explícito e para não espalhar a string pelo código.
 */
export const RouteProfile = {
  DRIVING: 'driving',
} as const;
export type RouteProfile = (typeof RouteProfile)[keyof typeof RouteProfile];

/**
 * Manobra de um passo da rota. Vocabulário reduzido e PRÓPRIO (não é o do OSRM):
 * o adaptador do provedor traduz para cá, então trocar de provedor não vaza o
 * vocabulário dele para o app e para as instruções em pt-BR.
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

/**
 * Distância (m) do traçado a partir da qual o agente é considerado FORA da rota e
 * dispara recálculo. 50 m absorve o erro típico de GPS urbano (5–20 m) e a largura
 * de pistas paralelas sem disparar recálculo a cada oscilação.
 */
export const ROUTE_DEVIATION_METERS = 50;

/** Raio (m) do destino que marca a rota como concluída. */
export const ROUTE_ARRIVAL_METERS = 30;

/** Tipos de mensagem tática. */
export const MessageType = {
  TEXT: 'text',
  MEDIA: 'media',
  /** Diretiva da central para todos os agentes da operação (canal broadcast). */
  BROADCAST: 'broadcast',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Motivo da revogação de uma sessão — dirige a UX do app (apagar ou não a chave E2EE). */
export const SessionRevokeReason = {
  KICKED: 'kicked',
  ACCOUNT_BLOCKED: 'account_blocked',
  DEVICE_BLOCKED: 'device_blocked',
  SESSION_REVOKED: 'session_revoked',
} as const;
export type SessionRevokeReason = (typeof SessionRevokeReason)[keyof typeof SessionRevokeReason];

/** Plataforma do dispositivo do agente. */
export const DevicePlatform = {
  ANDROID: 'android',
  IOS: 'ios',
  WEB: 'web',
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];
