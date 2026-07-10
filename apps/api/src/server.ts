import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

/** Ponto de entrada do Servidor Central. */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.API_HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
