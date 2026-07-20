/**
 * ROSTER DA SIMULAÇÃO — fonte ÚNICA de verdade das equipes e agentes simulados.
 *
 * Consumido por DOIS scripts que precisam concordar:
 *  - `setup-simulation.ts` CADASTRA no banco (operação + usuários-agente + equipes).
 *  - `simulate-agents.ts` PUBLICA a telemetria desses mesmos agentes no barramento.
 * Manter aqui evita que o cadastro e a simulação usem ids/equipes diferentes.
 *
 * `circuit` é a região que a equipe patrulha (waypoints [lng,lat], ordem GeoJSON — ver
 * .claude/rules/geospatial-coordinates.md). Os agentes de uma equipe seguem o MESMO
 * traçado, escalonados alguns metros à frente um do outro (coluna de patrulha), então
 * cada equipe aparece como um grupo distinto no mapa.
 */

/** Ponto GeoJSON `[longitude, latitude]`. */
export type LngLat = [number, number];

export interface SimTeam {
  /** Nome exibido no dashboard (pt-BR — texto de UI). */
  name: string;
  /** Cor: token de família Tailwind (mesmo formato de `Team.color`, ex.: 'blue'). */
  color: string;
  /** Canais de agente da equipe (casam com `Position.agentId` e o tópico MQTT). */
  agents: string[];
  /** Líder da equipe (∈ agents). */
  leadId: string;
  /** Região patrulhada — waypoints [lng,lat] encaixados nas ruas pelo OSRM em runtime. */
  circuit: LngLat[];
}

/** Nome da operação de simulação (idempotência: o setup faz upsert por este nome). */
export const SIM_OPERATION_NAME = 'SIMULAÇÃO';

/**
 * Duas equipes em regiões distintas de Belo Horizonte, para as equipes ficarem
 * visualmente separadas no mapa (cores + agrupamento + filtro por equipe).
 */
export const SIM_TEAMS: SimTeam[] = [
  {
    name: 'Equipe Alfa',
    color: 'blue',
    agents: ['AG-SIM-01', 'AG-SIM-02', 'AG-SIM-03'],
    leadId: 'AG-SIM-01',
    // Centro: Praça Sete → Mercado Central → Parque Municipal
    circuit: [
      [-43.9386, -19.9208],
      [-43.9407, -19.9186],
      [-43.9333, -19.9227],
    ],
  },
  {
    name: 'Equipe Bravo',
    color: 'green',
    agents: ['AG-SIM-04', 'AG-SIM-05', 'AG-SIM-06'],
    leadId: 'AG-SIM-04',
    // Savassi → Praça da Liberdade → Praça do Papa
    circuit: [
      [-43.9337, -19.9386],
      [-43.9386, -19.9319],
      [-43.921, -19.9455],
    ],
  },
];

/** Todos os agentes da simulação, na ordem das equipes. */
export const SIM_AGENTS: string[] = SIM_TEAMS.flatMap((t) => t.agents);

/** A equipe de um agente (ou undefined se não estiver no roster). */
export function teamOf(agentId: string): SimTeam | undefined {
  return SIM_TEAMS.find((t) => t.agents.includes(agentId));
}

/** Nome de exibição do agente — usado no cadastro (`User.name`). */
export function agentDisplayName(agentId: string): string {
  const team = teamOf(agentId);
  const n = agentId.slice(-2);
  return team ? `Agente Sim ${n} (${team.name.replace('Equipe ', '')})` : `Agente Sim ${n}`;
}

/** Username derivado do agentId (minúsculo, estável) — usado no cadastro. */
export function agentUsername(agentId: string): string {
  return agentId.toLowerCase();
}
