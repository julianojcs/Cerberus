import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { OperationStatus, OperationType, Role } from '@cerberus/shared';
import { loadEnv } from '../config/env.js';
import { Operation, User } from '../models/index.js';

/** Mascara a senha da connection string para log seguro. */
function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:****@');
}

/**
 * Resolve a URI-alvo do seed e aplica a TRAVA DE SEGURANÇA. O seed é destrutivo
 * (apaga/recria usuários e a operação demo), então:
 * 1. Prefere `MONGO_URI_DEV` quando definida — evita semear produção por engano
 *    (o app usa `MONGO_URI`, que costuma apontar para o Atlas de produção).
 * 2. Recusa rodar contra um banco REMOTO (Atlas `mongodb+srv` ou host não-local)
 *    sem confirmação explícita (`SEED_ALLOW_REMOTE=1` ou `--force`).
 */
function resolveSeedUri(fallback: string): string {
  const uri = process.env.MONGO_URI_DEV ?? fallback;
  const isRemote = /mongodb\+srv:\/\//i.test(uri) || !/(localhost|127\.0\.0\.1)/i.test(uri);
  const allowRemote = process.env.SEED_ALLOW_REMOTE === '1' || process.argv.includes('--force');
  if (isRemote && !allowRemote) {
    console.error(`\n⛔ Seed ABORTADO — a URI aponta para um banco REMOTO:\n   ${maskUri(uri)}\n`);
    console.error('O seed APAGA e recria usuários (superadmin/admin/agente01) e a operação demo.');
    console.error('Se realmente quer semear este banco, rode com SEED_ALLOW_REMOTE=1 (ou --force).');
    console.error('Para semear LOCAL, defina MONGO_URI_DEV=mongodb://localhost:27017/cerberus.\n');
    process.exit(1);
  }
  return uri;
}

/**
 * Semeia dados mínimos para exercitar a fatia vertical:
 * 1 operação, 1 admin (central) e 1 agente de campo — ambos com escopo na operação.
 * Idempotente: recria a partir de credenciais fixas de desenvolvimento.
 */
async function seed(): Promise<void> {
  const env = loadEnv();
  const uri = resolveSeedUri(env.MONGO_URI);
  await mongoose.connect(uri);
  console.log(`Conectado ao MongoDB para seed... (${maskUri(uri)})`);

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
