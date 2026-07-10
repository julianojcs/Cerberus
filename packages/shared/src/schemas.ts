import { z } from 'zod';
import { ActivityType, MessageType, OperationStatus, OperationType, Role } from './constants.js';

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

/** Claims embutidos no JWT (reusado como credencial de conexão MQTT). */
export const authClaimsSchema = z.object({
  sub: z.string(), // userId
  role: z.enum(enumValues(Role)),
  agentId: z.string().optional(),
  /** Operações que o portador pode acessar (base do isolamento multitenant). */
  operationIds: z.array(z.string()).default([]),
});
export type AuthClaims = z.infer<typeof authClaimsSchema>;

/** Corpo de login. */
export const loginRequestSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
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
