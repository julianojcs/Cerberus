import { z } from 'zod';
import {
  ActivityType,
  DevicePlatform,
  MessageType,
  OperationStatus,
  OperationType,
  Role,
  type SessionRevokeReason,
} from './constants.js';

const enumValues = <T extends Record<string, string>>(obj: T) =>
  Object.values(obj) as [string, ...string[]];

/** Ponto GeoJSON `[longitude, latitude]` — formato exigido pelo índice 2dsphere. */
export const geoPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z
    .tuple([
      z.number().min(-180).max(180), // longitude
      z.number().min(-90).max(90), // latitude
    ])
    .describe('[longitude, latitude]'),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

/**
 * Amostra de telemetria publicada pelo agente no tópico `.../posicao`.
 * O `operationId`/`agentId` vêm do tópico; aqui vai apenas o payload.
 */
export const positionSampleSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  altitude: z.number().optional(),
  speed: z.number().nonnegative().nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  battery: z.number().min(0).max(1).optional(),
  activity: z.enum(enumValues(ActivityType)).optional(),
  /** Timestamp de captura no dispositivo (ISO 8601). Resiliência offline preserva a ordem real. */
  capturedAt: z.string().datetime(),
});
export type PositionSample = z.infer<typeof positionSampleSchema>;

/**
 * Presença do agente no canal `status` (`operacao/{op}/agente/{id}/status`).
 *
 * Publicado com `retain` na conexão (`online: true`) e, na saída limpa, com
 * `online: false`. Se o app morrer sem se despedir (rede caiu, processo morto), o
 * BROKER publica `online: false` sozinho, via LWT (Last Will and Testament) — ver
 * docs/decisions/adr-0004-presenca-do-agente-mqtt-lwt.md.
 *
 * Sem `agentId` no corpo de propósito: a identidade vem do TÓPICO, nunca do payload
 * (ver .claude/rules/mqtt-multitenant.md). O payload do LWT é fixado no CONNECT, por
 * isso também não carrega timestamp — o instante é o da recepção.
 */
export const agentStatusSchema = z.object({
  online: z.boolean(),
});
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Documento de posição persistido (inclui identificadores e GeoJSON). */
export const positionRecordSchema = positionSampleSchema.extend({
  operationId: z.string(),
  agentId: z.string(),
  location: geoPointSchema,
  receivedAt: z.string().datetime(),
});
export type PositionRecord = z.infer<typeof positionRecordSchema>;

/** Mensagem tática (texto no MVP; `ciphertext` reservado para E2EE na fase 2). */
export const messageSchema = z.object({
  operationId: z.string(),
  senderId: z.string(),
  type: z.enum(enumValues(MessageType)),
  text: z.string().max(4096).optional(),
  ciphertext: z.string().optional(),
  mediaRef: z.string().optional(),
  capturedAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

/** Registro da chave pública X25519 (base64 de 32 bytes = 44 chars) para E2EE. */
export const publicKeyRegistrationSchema = z.object({
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'Chave pública inválida'),
});
export type PublicKeyRegistration = z.infer<typeof publicKeyRegistrationSchema>;

/**
 * Backup da chave E2EE cifrado NO CLIENTE (Fase 5e-3). O que trafega/persiste é só o
 * blob AES-GCM da(s) secreta(s), embrulhado pela passphrase do operador (PBKDF2). O
 * servidor guarda opaco — nunca vê a chave nem a senha. Restaurável em outro
 * dispositivo/origem desbloqueando localmente com a mesma senha.
 */
export const e2eeKeyBackupSchema = z.object({
  v: z.literal(1),
  salt: z.string().min(1).max(64), // base64
  iv: z.string().min(1).max(64), // base64
  ct: z.string().min(1).max(8192), // base64 (AES-GCM da lista de secretas)
});
export type E2eeKeyBackup = z.infer<typeof e2eeKeyBackupSchema>;

/**
 * Entrada do diretório de chaves de uma operação. `id` é o identificador usado
 * como destinatário no envelope E2EE (agentId do agente, ou userId do admin).
 */
export interface KeyDirectoryEntry {
  id: string;
  userId: string;
  role: Role;
  agentId?: string;
  publicKey: string;
  /** Fase 5e-2 — chaves públicas antigas (rotação); a verificação de remetente aceita todas. */
  keyHistory?: string[];
  /** Fase 5e-2 — chave atual revogada (não selar novas mensagens para ela). */
  revoked?: boolean;
}

/** Claims embutidos no JWT (reusado como credencial de conexão MQTT). */
export const authClaimsSchema = z.object({
  sub: z.string(), // userId
  role: z.enum(enumValues(Role)),
  agentId: z.string().optional(),
  /** Operações que o portador pode acessar (base do isolamento multitenant). */
  operationIds: z.array(z.string()).default([]),
  /** Id da sessão (login de dispositivo). Ausente em tokens legados → fail-open. */
  sid: z.string().optional(),
});
export type AuthClaims = z.infer<typeof authClaimsSchema>;

/** Corpo de login. Os campos de dispositivo habilitam gestão/bloqueio por dispositivo. */
export const loginRequestSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  deviceId: z.string().min(1).max(200).optional(),
  deviceLabel: z.string().max(120).optional(),
  platform: z.enum(enumValues(DevicePlatform)).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    name: z.string(),
    role: z.enum(enumValues(Role)),
    agentId: z.string().optional(),
    operationIds: z.array(z.string()),
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Operação (missão) — unidade de isolamento multitenant. */
export const operationSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(enumValues(OperationType)),
  status: z.enum(enumValues(OperationStatus)),
  createdAt: z.string().datetime(),
});
export type Operation = z.infer<typeof operationSchema>;

/** Sessão (login de um dispositivo) — linha da lista de dispositivos do SA. */
export interface SessionInfo {
  id: string;
  userId: string;
  deviceId?: string;
  deviceLabel?: string;
  platform?: DevicePlatform;
  ip?: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  revokedReason?: SessionRevokeReason;
}

/** Dispositivo bloqueado (denylist permanente). */
export interface DeviceBlockInfo {
  deviceId: string;
  blockedBy: string;
  reason?: string;
  createdAt: string;
}

/** Entrada do log de auditoria de ações sensíveis. */
export interface AuditLogEntry {
  id: string;
  actorId: string;
  action: string;
  targetUserId?: string;
  targetDeviceId?: string;
  targetSid?: string;
  reason?: string;
  ip?: string;
  createdAt: string;
}

/** Usuário serializado (lista/CRUD do painel Admin). Nunca inclui o hash da senha. */
export interface UserInfo {
  id: string;
  username: string;
  name: string;
  role: Role;
  agentId?: string;
  operationIds: string[];
  blocked: boolean;
}

/** Equipe (sub-grupo de uma operação) serializada — lista/CRUD + filtro no mapa. */
export interface TeamInfo {
  id: string;
  operationId: string;
  name: string;
  color: string; // token de família Tailwind (ex.: 'blue')
  leadId?: string; // agentId do líder
  agentIds: string[]; // canais de agente (⊆ agentes da operação)
  createdAt: string;
}
