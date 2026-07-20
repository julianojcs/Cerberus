/**
 * Rotas de controle da simulação (issue #134) — Iniciar / Pausar / Parar pelo dashboard.
 *
 * DEFESA EM PROFUNDIDADE (as três precisam valer, senão `guard` recusa):
 *  1. `SIMULATION_ENABLED` — desligado em produção real; o endpoint some (404).
 *  2. Nome da operação === `SIMULAÇÃO` — nenhuma operação real pode ser simulada.
 *  3. Papel admin/superadmin, com escopo na operação.
 *
 * O `GET` devolve o status e serve de gate do componente do dashboard: se a API recusar,
 * o botão nem aparece. Quem GERA a telemetria falsa é a API (componente confiável) — o
 * navegador nunca publica no canal do agente (ver `.claude/rules/mqtt-multitenant.md`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { Role, type AuthClaims } from '@cerberus/shared';
import { Operation } from '../../models/index.js';
import { assertOperationScope, isSuperAdmin } from '../scope.js';
import { SIM_OPERATION_NAME } from './roster.js';
import { pauseSimulation, simulationStatus, startSimulation, stopSimulation } from './service.js';

/**
 * Aplica as três travas. Retorna `true` se autorizado (segue o handler); em qualquer
 * recusa já respondeu e retorna `false`. `404` quando a feature está desligada — nem
 * revela a existência do endpoint; `403` para operação/papel indevidos.
 */
async function guard(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  operationId: string,
): Promise<boolean> {
  if (!app.env.SIMULATION_ENABLED) {
    reply.code(404).send({ error: 'Recurso indisponível' });
    return false;
  }
  if (!assertOperationScope(request, reply, operationId)) return false;

  const claims = request.user as AuthClaims;
  if (!isSuperAdmin(claims) && claims.role !== Role.ADMIN) {
    reply.code(403).send({ error: 'Apenas a central pode controlar a simulação' });
    return false;
  }
  if (!Types.ObjectId.isValid(operationId)) {
    reply.code(400).send({ error: 'Identificador inválido' });
    return false;
  }
  const operation = await Operation.findById(operationId).select('name').lean();
  if (!operation || operation.name !== SIM_OPERATION_NAME) {
    reply.code(403).send({ error: `A simulação só vale para a operação "${SIM_OPERATION_NAME}"` });
    return false;
  }
  return true;
}

export async function simulationRoutes(app: FastifyInstance): Promise<void> {
  // Ao derrubar o processo, encerra os laços — evita timers órfãos nos testes e no reload.
  app.addHook('onClose', async () => {
    const { clearAllSimulations } = await import('./service.js');
    clearAllSimulations();
  });

  app.get(
    '/operations/:id/simulation',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await guard(app, request, reply, id))) return;
      return simulationStatus(id);
    },
  );

  app.post(
    '/operations/:id/simulation/start',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await guard(app, request, reply, id))) return;
      await startSimulation(app, id);
      return reply.code(202).send(simulationStatus(id));
    },
  );

  app.post(
    '/operations/:id/simulation/pause',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await guard(app, request, reply, id))) return;
      pauseSimulation(id);
      return simulationStatus(id);
    },
  );

  app.post(
    '/operations/:id/simulation/stop',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await guard(app, request, reply, id))) return;
      stopSimulation(app, id);
      return simulationStatus(id);
    },
  );
}
