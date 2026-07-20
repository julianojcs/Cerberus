/**
 * Serviço de simulação hospedada (issue #134) — ciclo de vida em processo.
 *
 * Mantém, POR OPERAÇÃO, um laço que a cada tick avança os agentes do roster e publica a
 * posição no barramento pelo cliente MQTT da própria API. Estados: rodando, pausado
 * (laço parado, presença mantida) e parado (presença zerada, estado descartado).
 *
 * As TRAVAS de segurança (flag de ambiente, nome da operação, papel) ficam na borda das
 * rotas — aqui é só mecanismo. Ver `.claude/rules/mqtt-multitenant.md`: quem escreve no
 * canal do agente é a API (componente confiável), nunca o navegador.
 */
import type { FastifyInstance } from 'fastify';
import {
  agentPositionTopic,
  agentStatusTopic,
  type AgentStatus,
  type PositionSample,
} from '@cerberus/shared';
import { SIM_INTERVAL_MS, agentTag, buildAgentRuns, stepAgent, type AgentRun } from './engine.js';

interface OperationSim {
  paused: boolean;
  timer: NodeJS.Timeout | null;
  agents: AgentRun[];
  startedAt: string;
}

/** Estado vivo por `operationId`. Uma operação = um laço, agentes distintos em paralelo. */
const sims = new Map<string, OperationSim>();

export interface SimulationStatus {
  running: boolean;
  paused: boolean;
  agentIds: string[];
  startedAt: string | null;
}

export function simulationStatus(operationId: string): SimulationStatus {
  const sim = sims.get(operationId);
  return {
    running: !!sim,
    paused: sim?.paused ?? false,
    agentIds: sim ? sim.agents.map((a) => a.agentId) : [],
    startedAt: sim?.startedAt ?? null,
  };
}

function publishSample(app: FastifyInstance, operationId: string, run: AgentRun): void {
  if (!app.mqtt.connected) return;
  const sample: PositionSample = stepAgent(run);
  app.mqtt.publish(agentPositionTopic(operationId, run.agentId), JSON.stringify(sample), {
    qos: 1,
  });
}

function publishPresence(
  app: FastifyInstance,
  operationId: string,
  agentId: string,
  online: boolean,
): void {
  if (!app.mqtt.connected) return;
  // Presença RETIDA (mesmo contrato do agente real, ADR-0004): o dashboard vê o estado
  // assim que assina, sem esperar a próxima posição.
  app.mqtt.publish(
    agentStatusTopic(operationId, agentId),
    JSON.stringify({ online } satisfies AgentStatus),
    { qos: 1, retain: true },
  );
}

function tick(app: FastifyInstance, operationId: string): void {
  const sim = sims.get(operationId);
  if (!sim || sim.paused) return;
  for (const run of sim.agents) publishSample(app, operationId, run);
}

/**
 * Inicia (ou RETOMA, se pausada) a simulação da operação. Idempotente: chamar com uma
 * simulação já rodando não faz nada. A montagem dos agentes roteia os circuitos no OSRM
 * (assíncrono), por isso o `await`.
 */
export async function startSimulation(app: FastifyInstance, operationId: string): Promise<void> {
  const existing = sims.get(operationId);
  if (existing) {
    if (existing.paused) {
      existing.paused = false;
      existing.timer = setInterval(() => tick(app, operationId), SIM_INTERVAL_MS);
      app.log.info({ operationId }, 'Simulação retomada');
    }
    return; // já rodando — no-op
  }

  const agents = await buildAgentRuns(app.env.OSRM_BASE_URL);
  for (const run of agents) publishPresence(app, operationId, run.agentId, true);

  const sim: OperationSim = {
    paused: false,
    timer: setInterval(() => tick(app, operationId), SIM_INTERVAL_MS),
    agents,
    startedAt: new Date().toISOString(),
  };
  sims.set(operationId, sim);
  app.log.info(
    { operationId, agents: agents.map((a) => agentTag(a.agentId)) },
    'Simulação iniciada',
  );
}

/** Pausa: para o laço, mantém a presença (o agente segue "online", só não anda). */
export function pauseSimulation(operationId: string): void {
  const sim = sims.get(operationId);
  if (!sim || sim.paused) return;
  if (sim.timer) clearInterval(sim.timer);
  sim.timer = null;
  sim.paused = true;
}

/** Para: encerra o laço, publica `offline` de cada agente e descarta o estado. */
export function stopSimulation(app: FastifyInstance, operationId: string): void {
  const sim = sims.get(operationId);
  if (!sim) return;
  if (sim.timer) clearInterval(sim.timer);
  for (const run of sim.agents) publishPresence(app, operationId, run.agentId, false);
  sims.delete(operationId);
  app.log.info({ operationId }, 'Simulação encerrada');
}

/** Encerra os laços de TODAS as operações (desligamento do processo) — só limpa timers. */
export function clearAllSimulations(): void {
  for (const sim of sims.values()) {
    if (sim.timer) clearInterval(sim.timer);
  }
  sims.clear();
}
