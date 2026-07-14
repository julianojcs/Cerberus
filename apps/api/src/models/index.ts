import { Schema, model, type InferSchemaType } from 'mongoose';
import { ActivityType, MessageType, OperationStatus, OperationType, Role } from '@cerberus/shared';

/* ------------------------------------------------------------------ Users */

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(Role), required: true },
    /** Preenchido quando role = agente. Identifica o canal MQTT do agente. */
    agentId: { type: String, index: true },
    /** Operações às quais o usuário tem acesso (base do isolamento multitenant). */
    operationIds: { type: [Schema.Types.ObjectId], ref: 'Operation', default: [] },
    /** Chave pública X25519 (base64) para E2EE. A privada nunca chega ao servidor. */
    publicKey: { type: String },
    /** Conta bloqueada pelo SA — barra o login e revoga as sessões existentes. */
    blocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);

/* ------------------------------------------------------------- Operations */

const operationSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: Object.values(OperationType), required: true },
    status: {
      type: String,
      enum: Object.values(OperationStatus),
      default: OperationStatus.PLANEJADA,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export type OperationDoc = InferSchemaType<typeof operationSchema>;
export const Operation = model('Operation', operationSchema);

/* -------------------------------------------------------------- Positions */

const positionSchema = new Schema(
  {
    operationId: { type: String, required: true },
    agentId: { type: String, required: true },
    /** GeoJSON Point [lng, lat] — habilita consultas de proximidade (geofencing). */
    location: {
      type: { type: String, enum: ['Point'], default: 'Point', required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    accuracy: Number,
    altitude: Number,
    speed: Number,
    heading: Number,
    battery: Number,
    activity: { type: String, enum: Object.values(ActivityType) },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
// Índice geoespacial nativo 2dsphere (consultas de proximidade / geofencing).
positionSchema.index({ location: '2dsphere' });
// Consulta operacional dominante: trilha de um agente numa operação ao longo do tempo.
positionSchema.index({ operationId: 1, agentId: 1, capturedAt: -1 });
export type PositionDoc = InferSchemaType<typeof positionSchema>;
export const Position = model('Position', positionSchema);

/* --------------------------------------------------------------- Messages */

const messageSchema = new Schema(
  {
    operationId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    type: { type: String, enum: Object.values(MessageType), required: true },
    /** Texto em claro (MVP). Substituído por `ciphertext` na fase de E2EE. */
    text: String,
    ciphertext: String,
    mediaRef: String,
    /** Geotag da mídia (onde a foto foi capturada): GeoJSON Point [lng, lat]. */
    location: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
messageSchema.index({ operationId: 1, capturedAt: -1 });
export type MessageDoc = InferSchemaType<typeof messageSchema>;
export const MessageModel = model('Message', messageSchema);

// --- Geofencing (Fase 4) ---
const geofenceSchema = new Schema(
  {
    operationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    /** Centro da zona (círculo): GeoJSON Point [lng, lat]. */
    center: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    radiusMeters: { type: Number, required: true, min: 1 },
    /** Cor PRIMARIA da zona: token de familia da paleta Tailwind (ex.: 'green'). */
    color: { type: String, default: 'green' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
geofenceSchema.index({ center: '2dsphere' });
export type GeofenceDoc = InferSchemaType<typeof geofenceSchema>;
export const Geofence = model('Geofence', geofenceSchema);

const alertSchema = new Schema(
  {
    operationId: { type: String, required: true, index: true },
    agentId: { type: String, required: true },
    geofenceId: { type: String, required: true },
    geofenceName: { type: String, required: true },
    type: { type: String, enum: ['enter', 'exit'], required: true },
    /** Local onde a transição foi detectada: GeoJSON Point [lng, lat]. */
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
alertSchema.index({ operationId: 1, receivedAt: -1 });
export type AlertDoc = InferSchemaType<typeof alertSchema>;
export const Alert = model('Alert', alertSchema);

/**
 * Estado de pertencimento agente↔zona: guarda se o agente está DENTRO de cada
 * geofence. É a fonte de verdade para detectar transições enter/exit sem depender
 * de reconstruir a "posição anterior" (frágil a rajadas/ordem de chegada).
 */
const geofenceMembershipSchema = new Schema(
  {
    operationId: { type: String, required: true },
    agentId: { type: String, required: true },
    geofenceId: { type: String, required: true },
    inside: { type: Boolean, required: true },
    updatedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
geofenceMembershipSchema.index({ operationId: 1, agentId: 1, geofenceId: 1 }, { unique: true });
export type GeofenceMembershipDoc = InferSchemaType<typeof geofenceMembershipSchema>;
export const GeofenceMembership = model('GeofenceMembership', geofenceMembershipSchema);

/* -------------------------------------------------------------- Settings */

/**
 * Configurações do sistema (documento único/global). Ajustes básicos de exibição
 * definidos pelo admin. O campo `key` é fixo ('system') e único, garantindo o
 * padrão singleton (um único documento).
 */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'system', unique: true },
    /** Nº mínimo de pontos para uma rota ser listada/plotada (descarta trechos insignificantes). */
    minRoutePoints: { type: Number, default: 5, min: 1 },
    /** Ligar rotas: desenha uma linha do último ponto de uma rota ao primeiro da próxima. */
    connectRoutes: { type: Boolean, default: false },
    /** Intervalo (min) sem transmissão que QUEBRA a rota em segmentos (evita o "pulo"). */
    maxGapMinutes: { type: Number, default: 5, min: 1 },
  },
  { timestamps: true },
);
export type SettingsDoc = InferSchemaType<typeof settingsSchema>;
export const Settings = model('Settings', settingsSchema);

/* ---------------------------------------------------- Sessões / Dispositivos */

/**
 * Sessão = um login de dispositivo. Fonte única da revogação: um token é válido
 * SSE a sessão existe e `revokedAt` é nulo. O `_id` viaja como `sid` no JWT.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Identidade do dispositivo (asserida pelo cliente — controle operacional, não fronteira). */
    deviceId: { type: String, index: true },
    deviceLabel: { type: String },
    platform: { type: String },
    ip: { type: String },
    lastSeenAt: { type: Date },
    revokedAt: { type: Date },
    revokedReason: { type: String },
  },
  { timestamps: true },
);
sessionSchema.index({ userId: 1, createdAt: -1 });
export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const Session = model('Session', sessionSchema);

/** Denylist de dispositivos bloqueados permanentemente (barra o login). */
const deviceBlockSchema = new Schema(
  {
    deviceId: { type: String, required: true, unique: true },
    blockedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String },
  },
  { timestamps: true },
);
export type DeviceBlockDoc = InferSchemaType<typeof deviceBlockSchema>;
export const DeviceBlock = model('DeviceBlock', deviceBlockSchema);

/** Trilha de auditoria de ações sensíveis (kick/block/unblock). */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    targetDeviceId: { type: String },
    targetSid: { type: String },
    reason: { type: String },
    ip: { type: String },
  },
  { timestamps: true },
);
auditLogSchema.index({ createdAt: -1 });
export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model('AuditLog', auditLogSchema);
