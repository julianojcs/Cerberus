import type { MqttClient } from 'mqtt';
import {
  AgentCommandType,
  agentCommandTopic,
  RouteProfile,
  RouteSource,
  RouteStatus,
} from '@cerberus/shared';
import { Position, Route } from '../../models/index.js';
import type { GeoPoint } from '../geofences/detect.js';
import { computeRouteWithFallback, type RoutingProvider } from './provider.js';

/**
 * Criação e despacho de rotas (issue #131). Vive fora de `routes.ts` porque DOIS
 * caminhos criam rota: o operador/agente via HTTP e a ponte de ingest quando detecta
 * desvio e recalcula sozinha. Duplicar a sequência
 * "aposentar a anterior → calcular → persistir → despachar" nos dois lugares é como
 * se cria estado inconsistente (duas rotas ativas para o mesmo agente).
 */

/** Última posição conhecida do agente — origem de qualquer cálculo de rota. */
export async function lastKnownPosition(
  operationId: string,
  agentId: string,
): Promise<GeoPoint | null> {
  const last = await Position.findOne({ operationId, agentId })
    .sort({ capturedAt: -1 })
    .select('location')
    .lean();
  const [lng, lat] = last?.location?.coordinates ?? [];
  return lng != null && lat != null ? { lng, lat } : null;
}

/**
 * Publica um comando de rota no canal do agente. Fire-and-forget: o retorno diz que
 * FOI EMITIDO, não que o agente recebeu. O payload leva só o `routeId` — o traçado é
 * buscado por HTTPS (ver .claude/rules/mqtt-multitenant.md, canal `comando`).
 */
export function dispatchRouteCommand(
  client: MqttClient | undefined,
  operationId: string,
  agentId: string,
  type: AgentCommandType,
  routeId: string,
): boolean {
  if (!client?.connected) return false;
  client.publish(agentCommandTopic(operationId, agentId), JSON.stringify({ type, routeId }), {
    qos: 1,
  });
  return true;
}

export interface CreateRouteInput {
  operationId: string;
  agentId: string;
  source: RouteSource;
  origin: GeoPoint;
  destination: GeoPoint;
  label?: string;
  provider: RoutingProvider;
  mqtt?: MqttClient;
  createdBy?: string;
  /** Id da rota substituída (recálculo por desvio). */
  recalculatedFrom?: string;
}

/**
 * Calcula, persiste e despacha a rota, aposentando a ativa anterior do agente.
 *
 * A anterior vira `SUBSTITUIDA` ANTES da nova nascer: com duas rotas ativas a
 * detecção de desvio não saberia contra qual traçado medir.
 */
export async function createAndDispatchRoute(input: CreateRouteInput): Promise<{
  /** Documento já em objeto puro — quem chama serializa para a resposta. */
  route: Record<string, unknown>;
  dispatched: boolean;
}> {
  const computed = await computeRouteWithFallback(input.provider, input.origin, input.destination);

  const route = await Route.create({
    operationId: input.operationId,
    agentId: input.agentId,
    source: input.source,
    status: RouteStatus.ATIVA,
    profile: RouteProfile.DRIVING,
    destination: {
      type: 'Point',
      coordinates: [input.destination.lng, input.destination.lat],
    },
    destinationLabel: input.label,
    geometry: { type: 'LineString', coordinates: computed.geometry },
    steps: computed.steps,
    distanceMeters: computed.distanceMeters,
    durationSec: computed.durationSec,
    fallback: computed.fallback,
    recalculatedFrom: input.recalculatedFrom ?? null,
    createdBy: input.createdBy,
  });

  // Aposenta as anteriores DEPOIS de criar, e só as de `_id` menor que o meu.
  //
  // Aposentar antes de criar não basta: `updateMany` + `create` não são atômicos, então
  // dois despachos simultâneos (operador clicando duas vezes, ou um despacho concorrente
  // com o recálculo do servidor) passam ambos pela varredura e deixam DUAS rotas ativas.
  // Aposentar "todas menos a minha" depois é pior ainda — cada requisição mata a rota da
  // outra e não sobra nenhuma ativa.
  //
  // O corte por `_id` resolve: ObjectId é uma ordem total, então cada requisição só
  // aposenta rotas estritamente mais antigas e exatamente uma — a de maior `_id` —
  // sobrevive, independentemente da ordem em que as gravações chegarem.
  await Route.updateMany(
    {
      operationId: input.operationId,
      agentId: input.agentId,
      status: RouteStatus.ATIVA,
      _id: { $lt: route._id },
    },
    { $set: { status: RouteStatus.SUBSTITUIDA } },
  );

  const dispatched = dispatchRouteCommand(
    input.mqtt,
    input.operationId,
    input.agentId,
    AgentCommandType.ROUTE_ASSIGN,
    String(route._id),
  );
  return { route: route.toObject() as Record<string, unknown>, dispatched };
}
