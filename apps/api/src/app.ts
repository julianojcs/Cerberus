import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { corsOrigins, loadEnv, type Env } from './config/env.js';
import mongoPlugin from './plugins/mongo.js';
import authPlugin from './plugins/auth.js';
import mqttPlugin from './plugins/mqtt.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionRoutes } from './modules/sessions/routes.js';
import { operationRoutes } from './modules/operations/routes.js';
import { teamRoutes } from './modules/teams/routes.js';
import { positionRoutes } from './modules/positions/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { messageRoutes } from './modules/messages/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { geofenceRoutes } from './modules/geofences/routes.js';
import { navigationRoutes } from './modules/navigation/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
  }
}

export interface BuildOptions {
  /** Desliga a ponte MQTT (útil em testes de integração da API). */
  withMqtt?: boolean;
}

/**
 * Monta a instância Fastify com plugins de segurança, persistência e mensageria.
 * Segurança de transporte (fase 1): helmet, CORS restrito, rate-limit, JWT.
 * TLS 1.3 é terminado no proxy reverso (Nginx/Traefik) em produção.
 */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
          : undefined,
    },
  });

  app.decorate('env', env);

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: corsOrigins(env), credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  // Upload de mídia (fotos) do agente — limite de 8 MB, um arquivo por requisição.
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

  await app.register(mongoPlugin);
  await app.register(authPlugin);
  if (opts.withMqtt ?? true) {
    await app.register(mqttPlugin);
  }

  // Liveness/observabilidade: sempre 200 (o processo está de pé). O corpo reporta o
  // estado dos componentes — o health check do Render/proxy usa o 200; o corpo ajuda
  // a diagnosticar (mongo caído, barramento desconectado) sem derrubar o serviço.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'cerberus-api',
    time: new Date().toISOString(),
    mongo: app.mongoose?.connection?.readyState === 1 ? 'connected' : 'disconnected',
    mqtt: app.mqtt?.connected ? 'connected' : 'disconnected',
  }));

  await app.register(authRoutes);
  await app.register(sessionRoutes);
  await app.register(userRoutes);
  await app.register(operationRoutes);
  await app.register(teamRoutes);
  await app.register(positionRoutes);
  await app.register(messageRoutes);
  await app.register(mediaRoutes);
  await app.register(geofenceRoutes);
  await app.register(navigationRoutes);
  await app.register(settingsRoutes);

  return app;
}
