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
