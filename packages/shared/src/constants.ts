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
