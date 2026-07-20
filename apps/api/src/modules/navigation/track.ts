import type { MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';
import { operationBroadcastTopic, RouteStatus, type RouteSource } from '@cerberus/shared';
import { Route } from '../../models/index.js';
import type { GeoPoint } from '../geofences/detect.js';
import { evaluateProgress } from './progress.js';
import type { RoutingProvider } from './provider.js';
import { createAndDispatchRoute } from './service.js';

/**
 * Acompanhamento da rota ativa na ponte de ingest (issue #131): a cada posição
 * recebida, decide se o agente CHEGOU ou se DESVIOU do traçado.
 *
 * Roda no servidor e não no app de propósito. O servidor sempre tem a posição (ela
 * acabou de chegar) e sempre tem rede; o aparelho em campo pode estar sem sinal
 * justamente quando o desvio acontece. Assim o recálculo chega sozinho ao agente
 * assim que ele reconecta, sem depender de o app pedir.
 */

/** Desvios consecutivos antes de recalcular — ver `deviationStrikes` no modelo. */
const DEVIATION_STRIKES_TO_RECALCULATE = 2;

export interface TrackContext {
  log: FastifyBaseLogger;
  mqtt?: MqttClient;
  provider: RoutingProvider;
}

/**
 * Avalia a posição contra a rota ativa do agente. Nunca lança: o acompanhamento de
 * rota não pode derrubar a ingestão de telemetria, que é a função crítica da ponte.
 */
export async function trackRouteProgress(
  ctx: TrackContext,
  operationId: string,
  agentId: string,
  current: GeoPoint,
  capturedAt: string,
): Promise<void> {
  try {
    const route = await Route.findOne({ operationId, agentId, status: RouteStatus.ATIVA })
      .sort({ createdAt: -1 })
      .lean();
    if (!route) return;

    const geometry = (route.geometry?.coordinates ?? []) as [number, number][];
    const [dLng, dLat] = route.destination?.coordinates ?? [];
    if (dLng == null || dLat == null || geometry.length === 0) return;

    const progress = evaluateProgress(current, geometry, { lng: dLng, lat: dLat });

    if (progress.arrived) {
      await Route.updateOne(
        { _id: route._id, status: RouteStatus.ATIVA },
        { $set: { status: RouteStatus.CONCLUIDA, deviationStrikes: 0 } },
      );
      ctx.log.info({ operationId, agentId, routeId: String(route._id) }, 'Route completed');
      announce(ctx.mqtt, operationId, `${agentId} chegou ao destino`, capturedAt);
      return;
    }

    // Rota de fallback é a LINHA RETA: um agente dirigindo pelas ruas fica
    // permanentemente "fora" dela. Medir desvio aqui geraria recálculo em rajada —
    // e cada recálculo cairia no mesmo fallback, num laço que não converge.
    if (route.fallback) return;

    if (!progress.deviated) {
      if ((route.deviationStrikes ?? 0) > 0) {
        await Route.updateOne({ _id: route._id }, { $set: { deviationStrikes: 0 } });
      }
      return;
    }

    const strikes = (route.deviationStrikes ?? 0) + 1;
    if (strikes < DEVIATION_STRIKES_TO_RECALCULATE) {
      await Route.updateOne({ _id: route._id }, { $set: { deviationStrikes: strikes } });
      return;
    }

    ctx.log.info(
      { operationId, agentId, offRouteMeters: Math.round(progress.offRouteMeters) },
      'Agent off route — recalculating',
    );
    await createAndDispatchRoute({
      operationId,
      agentId,
      // O recálculo preserva a autoria: uma rota que o agente traçou para si continua
      // dele, mesmo quando quem recalculou foi o servidor.
      source: route.source as RouteSource,
      origin: current,
      destination: { lng: dLng, lat: dLat },
      label: route.destinationLabel ?? undefined,
      provider: ctx.provider,
      mqtt: ctx.mqtt,
      recalculatedFrom: String(route._id),
    });
    announce(ctx.mqtt, operationId, `Rota de ${agentId} recalculada (desvio)`, capturedAt);
  } catch (err) {
    // Telemetria é a função crítica da ponte; navegação é acessória.
    ctx.log.warn({ err, operationId, agentId }, 'Route tracking failed — ignored');
  }
}

/**
 * Anuncia o evento no broadcast da operação para o dashboard reagir sem consultar o
 * banco — mesmo padrão dos alertas de geofence (`senderId: 'GEOFENCE'`).
 */
function announce(
  client: MqttClient | undefined,
  operationId: string,
  text: string,
  capturedAt: string,
): void {
  if (!client?.connected) return;
  client.publish(
    operationBroadcastTopic(operationId),
    JSON.stringify({ senderId: 'ROTA', type: 'alert', text, capturedAt }),
    { qos: 1 },
  );
}
