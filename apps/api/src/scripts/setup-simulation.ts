/**
 * SETUP DA SIMULAÇÃO — cadastra no banco tudo que o simulador precisa para os agentes
 * aparecerem no dashboard COM nome e organizados em equipes:
 *  - a operação "SIMULAÇÃO" (upsert por nome);
 *  - os agentes do roster como USUÁRIOS (role=agente, com `agentId` e escopo na operação)
 *    — o dashboard só mostra o NOME do marcador para agentes cadastrados;
 *  - as EQUIPES (com cor e agentes atribuídos);
 *  - o escopo do admin (para a operação aparecer na lista dele).
 *
 * ⚠️ Escreve no banco apontado por `MONGO_URI` — que no `.env` desta máquina é o
 * ATLAS DE PRODUÇÃO (por decisão do usuário: a ponte da API do Render grava lá). O
 * script imprime o alvo mascarado antes de agir. Use `--clean` para REMOVER tudo depois.
 *
 * Uso:
 *   npm run api:sim:setup            # cria/atualiza a operação, agentes e equipes
 *   npm run api:sim:setup -- --clean # remove a operação de simulação e seus dados
 *   SIM_ADMIN_USERNAME=admin npm run api:sim:setup   # a quem dar escopo (padrão: admin)
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { OperationStatus, OperationType, Role } from '@cerberus/shared';
import { loadEnv } from '../config/env.js';
import {
  Alert,
  Geofence,
  GeofenceMembership,
  Operation,
  Position,
  Team,
  User,
} from '../models/index.js';
import {
  SIM_AGENTS,
  SIM_OPERATION_NAME,
  SIM_TEAMS,
  agentDisplayName,
  agentUsername,
} from '../modules/simulation/roster.js';

/** Mascara a senha da connection string para log seguro. */
function maskUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:****@');
}

async function connect(): Promise<string> {
  const env = loadEnv();
  const uri = env.MONGO_URI;
  const isRemote = /mongodb\+srv:\/\//i.test(uri) || !/(localhost|127\.0\.0\.1)/i.test(uri);
  console.log(`Banco: ${maskUri(uri)} ${isRemote ? '(REMOTO — Atlas/produção)' : '(local)'}`);
  await mongoose.connect(uri);
  return uri;
}

async function findAdminIds(): Promise<mongoose.Types.ObjectId[]> {
  const username = process.env.SIM_ADMIN_USERNAME ?? 'admin';
  // Dá escopo ao admin nomeado (padrão 'admin'). O superadmin transcende o escopo e
  // enxerga a operação de qualquer forma — não precisa de entrada.
  const admins = await User.find({ username, role: Role.ADMIN }).select('_id').lean();
  return admins.map((a) => a._id);
}

async function setup(): Promise<void> {
  // 1) Operação (upsert por nome — idempotente).
  const operation = await Operation.findOneAndUpdate(
    { name: SIM_OPERATION_NAME },
    { $setOnInsert: { name: SIM_OPERATION_NAME, type: OperationType.ESCOLTA, status: OperationStatus.ATIVA } },
    { upsert: true, new: true },
  );
  const operationId = String(operation._id);

  // 2) Agentes como usuários (role=agente, com agentId + escopo na operação). Senha
  //    padrão de dev — permite logar no app com o agente simulado, se quiser.
  const passwordHash = await bcrypt.hash('cerberus123', 10);
  for (const agentId of SIM_AGENTS) {
    await User.updateOne(
      { username: agentUsername(agentId) },
      {
        $set: {
          username: agentUsername(agentId),
          name: agentDisplayName(agentId),
          passwordHash,
          role: Role.AGENTE,
          agentId,
          operationIds: [operation._id],
        },
      },
      { upsert: true },
    );
  }

  // 3) Equipes (upsert por (operationId, name) — há índice único). agentIds/leadId
  //    são canais de agente (strings), casando com Position.agentId.
  for (const team of SIM_TEAMS) {
    await Team.updateOne(
      { operationId, name: team.name },
      {
        $set: {
          operationId,
          name: team.name,
          color: team.color,
          agentIds: team.agents,
          leadId: team.leadId,
        },
      },
      { upsert: true },
    );
  }

  // 4) Escopo do admin (para a operação aparecer na lista dele).
  const adminIds = await findAdminIds();
  if (adminIds.length > 0) {
    await User.updateOne(
      { _id: { $in: adminIds } },
      { $addToSet: { operationIds: operation._id } },
    );
  }

  console.log('\n=== Simulação pronta (cadastro) ===');
  console.log(`OPERATION_ID:  ${operationId}`);
  console.log(`Operação:      ${SIM_OPERATION_NAME}`);
  for (const t of SIM_TEAMS) {
    console.log(`Equipe:        ${t.name} (${t.color}) — ${t.agents.join(', ')}  líder ${t.leadId}`);
  }
  console.log(
    adminIds.length > 0
      ? `Escopo:        operação adicionada ao admin '${process.env.SIM_ADMIN_USERNAME ?? 'admin'}' (o superadmin já vê tudo).`
      : `Escopo:        admin '${process.env.SIM_ADMIN_USERNAME ?? 'admin'}' não encontrado — entre como superadmin para ver a operação.`,
  );
  console.log('\nAgora rode a telemetria:');
  console.log(`  npm run api:sim -- --op ${operationId} --roster\n`);
}

/** Remove a operação de simulação e TODOS os dados derivados (reversão do setup). */
async function clean(): Promise<void> {
  const operation = await Operation.findOne({ name: SIM_OPERATION_NAME });
  if (!operation) {
    console.log(`Nada a limpar: operação "${SIM_OPERATION_NAME}" não existe.`);
    return;
  }
  const operationId = String(operation._id);

  const [pos, alerts, mem, teams, users] = await Promise.all([
    Position.deleteMany({ operationId }),
    Alert.deleteMany({ operationId }),
    GeofenceMembership.deleteMany({ operationId }),
    Team.deleteMany({ operationId }),
    User.deleteMany({ username: { $in: SIM_AGENTS.map(agentUsername) } }),
  ]);
  await Geofence.deleteMany({ operationId });
  // Tira a operação do escopo de quem a tinha.
  await User.updateMany({ operationIds: operation._id }, { $pull: { operationIds: operation._id } });
  await Operation.deleteOne({ _id: operation._id });

  console.log('\n=== Simulação removida ===');
  console.log(`Operação:      ${SIM_OPERATION_NAME} (${operationId})`);
  console.log(`Posições:      ${pos.deletedCount}`);
  console.log(`Alertas:       ${alerts.deletedCount}`);
  console.log(`Pertencimento: ${mem.deletedCount}`);
  console.log(`Equipes:       ${teams.deletedCount}`);
  console.log(`Agentes:       ${users.deletedCount}\n`);
}

async function main(): Promise<void> {
  await connect();
  try {
    if (process.argv.includes('--clean')) await clean();
    else await setup();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Falha no setup da simulação:', err);
  process.exit(1);
});
