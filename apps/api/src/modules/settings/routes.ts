import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Role } from '@cerberus/shared';
import { Settings } from '../../models/index.js';

const patchSchema = z.object({
  minRoutePoints: z.number().int().min(1).max(1000).optional(),
  connectRoutes: z.boolean().optional(),
  maxGapMinutes: z.number().int().min(1).max(1440).optional(),
  sidebarMessageCount: z.number().int().min(1).max(50).optional(),
});

const DEFAULTS = {
  minRoutePoints: 5,
  connectRoutes: false,
  maxGapMinutes: 5,
  sidebarMessageCount: 5,
};

/** Lê o documento único de configurações, criando-o com os padrões se ainda não existir. */
async function loadSettings() {
  const doc = await Settings.findOneAndUpdate(
    { key: 'system' },
    { $setOnInsert: { key: 'system', ...DEFAULTS } },
    { new: true, upsert: true },
  ).lean();
  return doc;
}

function serialize(s: Record<string, unknown>) {
  return {
    minRoutePoints: (s.minRoutePoints as number | undefined) ?? DEFAULTS.minRoutePoints,
    connectRoutes: (s.connectRoutes as boolean | undefined) ?? DEFAULTS.connectRoutes,
    maxGapMinutes: (s.maxGapMinutes as number | undefined) ?? DEFAULTS.maxGapMinutes,
    sidebarMessageCount:
      (s.sidebarMessageCount as number | undefined) ?? DEFAULTS.sidebarMessageCount,
  };
}

/**
 * Configurações do sistema (globais). Leitura por qualquer usuário autenticado
 * (o dashboard aplica na exibição das rotas); escrita restrita a admin.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', { onRequest: [app.authenticate] }, async () => {
    const s = await loadSettings();
    return serialize(s as Record<string, unknown>);
  });

  app.patch('/settings', { onRequest: [app.requireRole(Role.ADMIN)] }, async (request, reply) => {
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Dados inválidos' });

    const update: Record<string, unknown> = {};
    if (body.data.minRoutePoints !== undefined) update.minRoutePoints = body.data.minRoutePoints;
    if (body.data.connectRoutes !== undefined) update.connectRoutes = body.data.connectRoutes;
    if (body.data.maxGapMinutes !== undefined) update.maxGapMinutes = body.data.maxGapMinutes;
    if (body.data.sidebarMessageCount !== undefined)
      update.sidebarMessageCount = body.data.sidebarMessageCount;

    // `$setOnInsert` só com `key` — incluir os mesmos campos de `$set` geraria
    // conflito no MongoDB. No insert, os defaults do schema preenchem o restante.
    const s = await Settings.findOneAndUpdate(
      { key: 'system' },
      { $set: update, $setOnInsert: { key: 'system' } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return serialize(s as Record<string, unknown>);
  });
}
