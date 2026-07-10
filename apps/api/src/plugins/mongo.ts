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
  // Garante que os índices (inclusive 2dsphere) sejam construídos.
  await mongoose.syncIndexes();

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
