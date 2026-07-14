import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { OperationStatus, OperationType, Role } from '@cerberus/shared';
import { loadEnv } from '../config/env.js';
import { Operation, User } from '../models/index.js';

/**
 * Semeia dados mínimos para exercitar a fatia vertical:
 * 1 operação, 1 admin (central) e 1 agente de campo — ambos com escopo na operação.
 * Idempotente: recria a partir de credenciais fixas de desenvolvimento.
 */
async function seed(): Promise<void> {
  const env = loadEnv();
  await mongoose.connect(env.MONGO_URI);
  console.log('Conectado ao MongoDB para seed...');

  await Promise.all([
    User.deleteMany({ username: { $in: ['superadmin', 'admin', 'agente01'] } }),
    Operation.deleteMany({ name: 'Operação Cérbero (Demo)' }),
  ]);

  const operation = await Operation.create({
    name: 'Operação Cérbero (Demo)',
    type: OperationType.ESCOLTA,
    status: OperationStatus.ATIVA,
  });
  const operationId = String(operation._id);

  const passwordHash = await bcrypt.hash('cerberus123', 10);
  const agentId = 'AG-0456';

  const [superadmin, admin, agente] = await Promise.all([
    User.create({
      username: 'superadmin',
      name: 'Super Central',
      passwordHash,
      role: Role.SUPERADMIN,
      operationIds: [],
    }),
    User.create({
      username: 'admin',
      name: 'Central de Comando',
      passwordHash,
      role: Role.ADMIN,
      operationIds: [operation._id],
    }),
    User.create({
      username: 'agente01',
      name: 'Agente de Campo 01',
      passwordHash,
      role: Role.AGENTE,
      agentId,
      operationIds: [operation._id],
    }),
  ]);

  console.log('\n=== Seed concluído ===');
  console.log('Senha (todos):   cerberus123');
  console.log(`SuperAdmin:      ${superadmin.username}`);
  console.log(`Admin:           ${admin.username}`);
  console.log(`Agente:          ${agente.username}  (agentId=${agentId})`);
  console.log(`OPERATION_ID:    ${operationId}`);
  console.log(`AGENT_ID:        ${agentId}`);
  console.log('\nDica: use estes valores no publish-fake-position para simular telemetria.\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Falha no seed:', err);
  process.exit(1);
});
