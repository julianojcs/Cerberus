import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';

/**
 * Conecta ao MongoDB via Mongoose. A URI é injetada por ambiente, permitindo
 * apontar para Atlas M0 (MVP) ou para o Replica Set corporativo (DTI) sem tocar no código.
 */
export default fp(async function mongoPlugin(app: FastifyInstance) {
  const { MONGO_URI } = app.env;

  mongoose.connection.on('connected', () => app.log.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => app.log.error({ err }, 'MongoDB error'));
  mongoose.connection.on('disconnected', () => app.log.warn('MongoDB disconnected'));

  await mongoose.connect(MONGO_URI);

  // Sincroniza os índices (inclusive 2dsphere) em BACKGROUND — NÃO no caminho de boot.
  // Awaitar aqui bloqueava o `ready` do Fastify: no Atlas free, construir um índice novo
  // (ex.: o 2dsphere do `Route`) durante o cold start passa dos 10s do `pluginTimeout` e
  // derruba o deploy inteiro. As queries funcionam sem o índice pronto (só mais lentas)
  // enquanto ele constrói, então tirar do caminho crítico é seguro e resiliente.
  void mongoose.syncIndexes().then(
    () => app.log.info('Índices do MongoDB sincronizados'),
    (err) => app.log.error({ err }, 'Falha ao sincronizar índices do MongoDB'),
  );

  app.decorate('mongoose', mongoose);
  app.addHook('onClose', async () => {
    await mongoose.disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    mongoose: typeof mongoose;
  }
}
