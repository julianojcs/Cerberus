import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Role } from '@cerberus/shared';
import { loadEnv } from '../config/env.js';
import { User } from '../models/index.js';

/** Mascara a senha da connection string para log seguro. */
function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:****@');
}

/**
 * Garante (idempotente e NÃO-destrutivo) a existência de um SuperAdmin. Diferente do
 * `seed`, este script **não apaga nada** — só cria o superadmin se faltar e assegura
 * `role=superadmin` + `blocked=false`. É seguro rodar contra produção (Atlas) para
 * provisionar o SA sem tocar em operações/telemetria/usuários existentes.
 *
 * Variáveis: `SUPERADMIN_USERNAME` (padrão `superadmin`), `SUPERADMIN_PASSWORD`
 * (padrão `cerberus123`, aplicada só na criação), `SUPERADMIN_NAME` (padrão
 * `Super Central`). Para RESETAR a senha de um SA existente, use `SUPERADMIN_RESET=1`.
 */
async function ensureSuperadmin(): Promise<void> {
  const env = loadEnv();
  const uri = env.MONGO_URI;
  const username = process.env.SUPERADMIN_USERNAME ?? 'superadmin';
  const password = process.env.SUPERADMIN_PASSWORD ?? 'cerberus123';
  const name = process.env.SUPERADMIN_NAME ?? 'Super Central';
  const reset = process.env.SUPERADMIN_RESET === '1';

  await mongoose.connect(uri);
  console.log(`Conectado ao MongoDB (${maskUri(uri)})`);

  const existing = await User.findOne({ username });
  if (existing) {
    const update: Record<string, unknown> = { role: Role.SUPERADMIN, blocked: false };
    if (reset) update.passwordHash = await bcrypt.hash(password, 10);
    await User.updateOne({ _id: existing._id }, { $set: update });
    console.log(
      `SuperAdmin "${username}" já existe — garantido role=superadmin, blocked=false` +
        (reset ? ' e SENHA REDEFINIDA.' : ' (senha inalterada; use SUPERADMIN_RESET=1 para redefinir).'),
    );
  } else {
    await User.create({
      username,
      name,
      passwordHash: await bcrypt.hash(password, 10),
      role: Role.SUPERADMIN,
      operationIds: [],
    });
    console.log(`SuperAdmin "${username}" CRIADO (senha: a definida em SUPERADMIN_PASSWORD).`);
  }

  await mongoose.disconnect();
  console.log('Concluído — nenhum outro dado foi tocado.');
}

ensureSuperadmin().catch((err) => {
  console.error('Falha ao garantir o superadmin:', err);
  process.exit(1);
});
