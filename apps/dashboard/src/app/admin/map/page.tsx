'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OperationStatus, Role, type Operation, type TeamInfo } from '@cerberus/shared';
import { api, type LatestPosition, type Settings } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { assignAgentColors, buildRoutes, type Route } from '@/lib/routes';
import { resolveColor } from '@/lib/tailwind-colors';
import { AdminHeader } from '@/components/AdminHeader';
import { LiveMap, type AgentPoint, type AgentTrails, type PlottedRoute } from '@/components/LiveMap';
import { PeriodRange } from '@/components/PeriodRange';
import { ColorPalettePicker } from '@/components/ColorPalettePicker';
import { ResizableSidebar } from '@/components/ResizableSidebar';
import { STATUS_LABELS } from '@/components/OperationFormModal';
import { subscribeAllOperations, type LivePosition } from '@/lib/mqtt';
import { Toggle } from '@/components/Toggle';

const HISTORY_LIMIT = 5000;
const HOUR_MS = 60 * 60 * 1000;
const POLL_MS = 12_000;
/** Máximo de pontos por trilha ao vivo (limita memória/render). */
const MAX_LIVE_TRAIL = 2000;
const COLORS_KEY = 'cerberus_admin_agent_colors'; // ≠ chave por-operação da live page
const TEAM_COLORS_KEY = 'cerberus_admin_team_colors';
const COLOR_MODE_KEY = 'cerberus_admin_color_mode';
const PIN_KEY = 'cerberus_admin_period_pinned';

/** Data/hora local (America/Sao_Paulo) — exibição. O dado permanece UTC. */
function fmtDateTime(ms: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/**
 * Console operacional global do SuperAdmin: agentes de TODAS as operações num só
 * mapa, com seletor de operações + agentes, cor por agente, barra temporal e
 * plotagem de rotas — reusa o mesmo maquinário da live page por-operação
 * (`LiveMap`/`PeriodRange`/`buildRoutes`/`assignAgentColors`), agregando por operação.
 * Fase 2a: dimensão de EQUIPES — filtro por equipe (`teamVisible`) + cor por equipe
 * (`colorMode`/`teamColors`).
 */
export default function AdminMapPage() {
  const router = useRouter();
  const [ops, setOps] = useState<Operation[]>([]);
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set());
  // Histórico por operação (lazy: buscado na 1ª seleção) + últimas posições (poll).
  const [historyByOp, setHistoryByOp] = useState<Record<string, LatestPosition[]>>({});
  const [latestByOp, setLatestByOp] = useState<Record<string, LatestPosition[]>>({});
  // Ao vivo (MQTT): trilha por agente crescendo + status da conexão ao barramento.
  const [liveTrails, setLiveTrails] = useState<Record<string, [number, number][]>>({});
  const [showLiveTrail, setShowLiveTrail] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    minRoutePoints: 5,
    connectRoutes: false,
    maxGapMinutes: 5,
  });

  // Equipes (Fase 2a): filtro + cor por equipe.
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [teamColorOverrides, setTeamColorOverrides] = useState<Record<string, string>>({});
  const [colorMode, setColorMode] = useState<'agent' | 'team'>('agent');

  const [agentColorOverrides, setAgentColorOverrides] = useState<Record<string, string>>({});
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [nowTs] = useState(() => Date.now());
  const [windowStartMs, setWindowStartMs] = useState(0);
  const [windowEndMs, setWindowEndMs] = useState(0);
  const windowInitedRef = useRef(false);

  const [barHover, setBarHover] = useState(false);
  const [barPinned, setBarPinned] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [fitPoints, setFitPoints] = useState<[number, number][]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchingHistory = useRef<Set<string>>(new Set());

  // Preferências locais (só no cliente — evita mismatch de SSR).
  useEffect(() => {
    setBarPinned(localStorage.getItem(PIN_KEY) === '1');
    if (localStorage.getItem(COLOR_MODE_KEY) === 'team') setColorMode('team');
    try {
      const raw = localStorage.getItem(COLORS_KEY);
      if (raw) setAgentColorOverrides(JSON.parse(raw) as Record<string, string>);
      const rawT = localStorage.getItem(TEAM_COLORS_KEY);
      if (rawT) setTeamColorOverrides(JSON.parse(rawT) as Record<string, string>);
    } catch {
      /* preferência corrompida — ignora */
    }
  }, []);

  // Últimas posições de TODAS as operações (para contagem no seletor + marcadores).
  const refreshLatest = useCallback(async (list: Operation[]) => {
    const settled = await Promise.allSettled(
      list.map(async (o) => ({ id: o.id, positions: await api.latestPositions(o.id) })),
    );
    const next: Record<string, LatestPosition[]> = {};
    for (const r of settled) if (r.status === 'fulfilled') next[r.value.id] = r.value.positions;
    setLatestByOp(next);
  }, []);

  // Bootstrap: guarda SA + carrega operações/settings + poll de últimas posições.
  useEffect(() => {
    const u = getUser();
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    if (u?.role !== Role.SUPERADMIN) {
      router.replace('/operations');
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    api.settings().then(setSettings).catch(() => {});
    api.teams().then(setTeams).catch(() => {});
    api
      .operations()
      .then((list) => {
        setOps(list);
        // Padrão: operações abertas (não-encerradas) marcadas.
        setSelectedOpIds(new Set(list.filter((o) => o.status !== OperationStatus.ENCERRADA).map((o) => o.id)));
        void refreshLatest(list);
        timer = setInterval(() => void refreshLatest(list), POLL_MS);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [router, refreshLatest]);

  // AO VIVO: uma assinatura MQTT global (todas as operações). Cada posição atualiza
  // o marcador (via latestByOp) na hora e estende a trilha do agente — entre os polls.
  useEffect(() => {
    if (!getToken() || getUser()?.role !== Role.SUPERADMIN) return;
    const unsubscribe = subscribeAllOperations(
      (pos: LivePosition) => {
        setLatestByOp((prev) => {
          const rest = (prev[pos.operationId] ?? []).filter((p) => p.agentId !== pos.agentId);
          const merged: LatestPosition = {
            id: `live-${pos.agentId}-${pos.capturedAt}`,
            operationId: pos.operationId,
            agentId: pos.agentId,
            lng: pos.lng,
            lat: pos.lat,
            accuracy: pos.accuracy,
            speed: pos.speed ?? undefined,
            heading: pos.heading ?? undefined,
            battery: pos.battery,
            activity: pos.activity,
            capturedAt: pos.capturedAt,
          };
          return { ...prev, [pos.operationId]: [...rest, merged] };
        });
        setLiveTrails((prev) => {
          const cur = prev[pos.agentId] ?? [];
          const next: [number, number][] = [...cur, [pos.lng, pos.lat]];
          return {
            ...prev,
            [pos.agentId]: next.length > MAX_LIVE_TRAIL ? next.slice(-MAX_LIVE_TRAIL) : next,
          };
        });
      },
      getToken() ?? undefined,
      setLiveConnected,
    );
    return unsubscribe;
  }, []);

  // Lazy: garante o histórico de cada operação selecionada (busca uma vez).
  useEffect(() => {
    for (const opId of selectedOpIds) {
      if (historyByOp[opId] || fetchingHistory.current.has(opId)) continue;
      fetchingHistory.current.add(opId);
      api
        .positionHistory(opId, HISTORY_LIMIT)
        .then((positions) => setHistoryByOp((prev) => ({ ...prev, [opId]: positions })))
        .catch(() => {})
        .finally(() => fetchingHistory.current.delete(opId));
    }
  }, [selectedOpIds, historyByOp]);

  const opById = useMemo(() => Object.fromEntries(ops.map((o) => [o.id, o] as const)), [ops]);

  // Cor decorativa por operação (só o dot/borda do grupo — NÃO é a cor da rota).
  const opColors = useMemo(() => {
    const tokens = assignAgentColors(ops.map((o) => o.id));
    const out: Record<string, string> = {};
    for (const o of ops) out[o.id] = resolveColor(tokens[o.id]);
    return out;
  }, [ops]);

  // --- Equipes ---
  // agentId → equipes a que pertence (base do filtro) e a "primária" (base da cor).
  const agentTeamSet = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of teams)
      for (const a of t.agentIds) {
        let set = m.get(a);
        if (!set) {
          set = new Set();
          m.set(a, set);
        }
        set.add(t.id);
      }
    return m;
  }, [teams]);
  const teamOfAgent = useMemo(() => {
    const m = new Map<string, string>();
    for (const [agentId, set] of agentTeamSet) m.set(agentId, [...set][0]);
    return m;
  }, [agentTeamSet]);
  // Cor por equipe: cor salva da equipe (token) + override do SA, resolvida para hex.
  const teamColors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const t of teams) out[t.id] = resolveColor(teamColorOverrides[t.id] ?? t.color);
    return out;
  }, [teams, teamColorOverrides]);
  // Predicado do filtro: sem equipe selecionada = sem filtro; senão, agente precisa
  // pertencer a alguma equipe selecionada (agente sem equipe some com filtro ativo).
  const teamVisible = useCallback(
    (agentId: string) => {
      if (selectedTeamIds.size === 0) return true;
      const set = agentTeamSet.get(agentId);
      if (!set) return false;
      for (const id of set) if (selectedTeamIds.has(id)) return true;
      return false;
    },
    [selectedTeamIds, agentTeamSet],
  );
  // Equipes das operações selecionadas (mostradas no card de filtro).
  const relevantTeams = useMemo(
    () => teams.filter((t) => selectedOpIds.has(t.operationId)),
    [teams, selectedOpIds],
  );

  // Posições cruas (merge do histórico das operações selecionadas, filtrado por equipe).
  const rawPositions = useMemo(() => {
    const out: LatestPosition[] = [];
    for (const opId of selectedOpIds) {
      const h = historyByOp[opId];
      if (h) for (const p of h) if (teamVisible(p.agentId)) out.push(p);
    }
    return out;
  }, [selectedOpIds, historyByOp, teamVisible]);

  // Marcadores: última posição de cada agente nas operações selecionadas (dedup por
  // agente, a mais recente vence). Guarda também a operação de origem (popup/chips).
  const markerAgents = useMemo(() => {
    const byAgent = new Map<string, { p: LatestPosition; opId: string; t: number }>();
    for (const opId of selectedOpIds) {
      const list = latestByOp[opId];
      if (!list) continue;
      for (const p of list) {
        if (p.lat == null || p.lng == null) continue;
        if (!teamVisible(p.agentId)) continue;
        const t = +new Date(p.capturedAt);
        const prev = byAgent.get(p.agentId);
        if (prev && prev.t >= t) continue;
        byAgent.set(p.agentId, { p, opId, t });
      }
    }
    return byAgent;
  }, [selectedOpIds, latestByOp, teamVisible]);

  // Rotas por agente a partir do merge (segmentadas no gap configurável).
  const routes = useMemo(
    () => buildRoutes(rawPositions, settings.maxGapMinutes * 60_000),
    [rawPositions, settings.maxGapMinutes],
  );

  // Cor por agente: token auto-atribuído + override do SA, resolvido para hex. No modo
  // "equipe", o agente assume a cor da sua equipe (fallback: a própria cor do agente).
  const agentColors = useMemo(() => {
    const ids = new Set<string>([...Object.keys(routes), ...markerAgents.keys()]);
    const tokens = assignAgentColors([...ids]);
    const out: Record<string, string> = {};
    for (const id of ids) {
      const own = resolveColor(agentColorOverrides[id] ?? tokens[id]);
      if (colorMode === 'team') {
        const tid = teamOfAgent.get(id);
        out[id] = (tid && teamColors[tid]) || own;
      } else out[id] = own;
    }
    return out;
  }, [routes, markerAgents, agentColorOverrides, colorMode, teamOfAgent, teamColors]);

  // Agentes → LiveMap (marcadores na cor do agente + operação no popup).
  const agents = useMemo<Record<string, AgentPoint>>(() => {
    const out: Record<string, AgentPoint> = {};
    for (const [agentId, { p, opId }] of markerAgents) {
      out[agentId] = {
        agentId,
        lat: p.lat,
        lng: p.lng,
        heading: p.heading,
        battery: p.battery,
        activity: p.activity,
        operationName: opById[opId]?.name,
      };
    }
    return out;
  }, [markerAgents, opById]);

  // Trilha ao vivo → formato do mapa (1 traço por agente), só para agentes VISÍVEIS
  // (markerAgents já aplicou os filtros de operação + equipe).
  const liveTrailsForMap = useMemo<AgentTrails>(() => {
    const out: AgentTrails = {};
    for (const [id, pts] of Object.entries(liveTrails)) {
      if (markerAgents.has(id)) out[id] = [pts];
    }
    return out;
  }, [liveTrails, markerAgents]);

  // Rotas exibíveis (≥ minRoutePoints) por agente.
  const visibleRoutes = useMemo(() => {
    const out: Record<string, Route[]> = {};
    for (const [agentId, rs] of Object.entries(routes)) {
      out[agentId] = rs.filter((r) => r.points.length >= settings.minRoutePoints);
    }
    return out;
  }, [routes, settings.minRoutePoints]);

  // Limites/janela do período (a partir do merge das operações selecionadas).
  const dataBounds = useMemo(() => {
    let first = Infinity;
    let last = -Infinity;
    for (const p of rawPositions) {
      if (p.lat == null || p.lng == null) continue;
      const t = +new Date(p.capturedAt);
      if (t < first) first = t;
      if (t > last) last = t;
    }
    return {
      first: Number.isFinite(first) ? first : null,
      last: Number.isFinite(last) ? last : null,
    };
  }, [rawPositions]);

  // Inicializa a janela uma vez, quando os primeiros dados chegam (últimas 24 h até
  // a última transmissão). Depois disso o SA ajusta livremente.
  useEffect(() => {
    if (windowInitedRef.current) return;
    if (dataBounds.first != null && dataBounds.last != null) {
      windowInitedRef.current = true;
      setWindowEndMs(dataBounds.last);
      setWindowStartMs(Math.max(dataBounds.first, dataBounds.last - 24 * HOUR_MS));
    }
  }, [dataBounds]);

  const rangeMin = dataBounds.first ?? nowTs - 24 * HOUR_MS;
  const rangeMax = nowTs;
  const inWindow = useCallback(
    (r: Route) => r.end >= windowStartMs && r.start <= windowEndMs,
    [windowStartMs, windowEndMs],
  );

  // Agrupamento: agentId → { operações em que aparece, operação mais recente }.
  // O filtro por equipe já foi aplicado em `rawPositions`/`markerAgents` (via `teamVisible`),
  // então este agrupamento herda os agentes visíveis.
  const agentOps = useMemo(() => {
    const map = new Map<string, { opIds: Set<string>; primaryOp: string; primaryT: number }>();
    for (const opId of selectedOpIds) {
      const h = historyByOp[opId];
      if (!h) continue;
      for (const p of h) {
        const t = +new Date(p.capturedAt);
        const e = map.get(p.agentId);
        if (!e) map.set(p.agentId, { opIds: new Set([opId]), primaryOp: opId, primaryT: t });
        else {
          e.opIds.add(opId);
          if (t > e.primaryT) {
            e.primaryT = t;
            e.primaryOp = opId;
          }
        }
      }
    }
    // Agentes só com última posição (sem histórico carregado ainda) entram também.
    for (const [agentId, { opId, t }] of markerAgents) {
      const e = map.get(agentId);
      if (!e) map.set(agentId, { opIds: new Set([opId]), primaryOp: opId, primaryT: t });
      else e.opIds.add(opId);
    }
    return map;
  }, [selectedOpIds, historyByOp, markerAgents]);

  // Agentes agrupados pela operação mais recente (multi-op aparece uma vez só).
  const groups = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const [agentId, e] of agentOps) (g[e.primaryOp] ??= []).push(agentId);
    for (const k of Object.keys(g)) g[k].sort();
    return g;
  }, [agentOps]);

  // Rotas efetivamente plotadas: selecionadas ∩ janela, na cor do agente (+ conectores).
  const plottedRoutes = useMemo<PlottedRoute[]>(() => {
    const out: PlottedRoute[] = [];
    for (const [agentId, rs] of Object.entries(visibleRoutes)) {
      const color = agentColors[agentId] ?? '#c1121f';
      const shown = rs
        .filter((r) => selectedRouteIds.has(r.id) && r.end >= windowStartMs && r.start <= windowEndMs)
        .sort((a, b) => a.start - b.start);
      for (const r of shown) out.push({ id: r.id, points: r.points, color });
      if (settings.connectRoutes) {
        for (let i = 0; i + 1 < shown.length; i++) {
          const from = shown[i].points[shown[i].points.length - 1];
          const to = shown[i + 1].points[0];
          if (from && to) {
            out.push({ id: `${shown[i].id}~${shown[i + 1].id}`, points: [from, to], color, dashed: true });
          }
        }
      }
    }
    return out;
  }, [visibleRoutes, agentColors, selectedRouteIds, windowStartMs, windowEndMs, settings.connectRoutes]);

  const agentCountByOp = useCallback(
    (opId: string) => latestByOp[opId]?.filter((p) => p.lat != null && p.lng != null).length ?? 0,
    [latestByOp],
  );

  // --- Ações ---
  function toggleOp(opId: string) {
    setSelectedOpIds((prev) => {
      const n = new Set(prev);
      if (n.has(opId)) n.delete(opId);
      else n.add(opId);
      return n;
    });
  }
  function setAllOps(on: boolean) {
    setSelectedOpIds(on ? new Set(ops.map((o) => o.id)) : new Set());
  }
  function toggleRoute(id: string) {
    setSelectedRouteIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function setRoutes(ids: string[], on: boolean) {
    setSelectedRouteIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  function toggleAgentRoutes(agentId: string) {
    const rw = (visibleRoutes[agentId] ?? []).filter(inWindow);
    const allSel = rw.length > 0 && rw.every((r) => selectedRouteIds.has(r.id));
    setRoutes(rw.map((r) => r.id), !allSel);
  }
  function toggleOpRoutes(opId: string) {
    const rw = (groups[opId] ?? []).flatMap((a) => (visibleRoutes[a] ?? []).filter(inWindow));
    const allSel = rw.length > 0 && rw.every((r) => selectedRouteIds.has(r.id));
    setRoutes(rw.map((r) => r.id), !allSel);
  }
  function setAgentColor(agentId: string, token: string) {
    setAgentColorOverrides((prev) => {
      const n = { ...prev, [agentId]: token };
      try {
        localStorage.setItem(COLORS_KEY, JSON.stringify(n));
      } catch {
        /* storage cheio/indisponível */
      }
      return n;
    });
  }
  function toggleTeam(teamId: string) {
    setSelectedTeamIds((prev) => {
      const n = new Set(prev);
      if (n.has(teamId)) n.delete(teamId);
      else n.add(teamId);
      return n;
    });
  }
  function setTeamColor(teamId: string, token: string) {
    setTeamColorOverrides((prev) => {
      const n = { ...prev, [teamId]: token };
      try {
        localStorage.setItem(TEAM_COLORS_KEY, JSON.stringify(n));
      } catch {
        /* storage cheio/indisponível */
      }
      return n;
    });
  }
  function pickColorMode(mode: 'agent' | 'team') {
    setColorMode(mode);
    localStorage.setItem(COLOR_MODE_KEY, mode);
  }
  function fit(points: [number, number][]) {
    if (points.length === 0) return;
    setFitPoints(points);
    setFitNonce((n) => n + 1);
  }
  function fitAll() {
    const pts: [number, number][] = [
      ...plottedRoutes.flatMap((r) => r.points),
      ...[...markerAgents.values()].map((m) => [m.p.lng, m.p.lat] as [number, number]),
    ];
    fit(pts);
  }
  function focusOp(opId: string) {
    const pts: [number, number][] = [];
    for (const [, m] of markerAgents) if (m.opId === opId) pts.push([m.p.lng, m.p.lat]);
    for (const a of groups[opId] ?? [])
      for (const r of visibleRoutes[a] ?? []) if (selectedRouteIds.has(r.id)) pts.push(...r.points);
    fit(pts);
  }
  function toggleGroup(opId: string) {
    setCollapsedGroups((prev) => {
      const n = new Set(prev);
      if (n.has(opId)) n.delete(opId);
      else n.add(opId);
      return n;
    });
  }

  const allOpsSelected = ops.length > 0 && selectedOpIds.size === ops.length;
  // Ordem de exibição dos grupos: pela ordem das operações; operações sem agentes ocultas.
  const groupOrder = useMemo(
    () => ops.filter((o) => selectedOpIds.has(o.id) && (groups[o.id]?.length ?? 0) > 0).map((o) => o.id),
    [ops, selectedOpIds, groups],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AdminHeader active="map" isSA />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ResizableSidebar storageKey="cerberus_admin_map_sidebar" defaultWidth={300}>
          {/* Operações */}
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 14 }}>Operações ({ops.length})</strong>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="badge"
                  onClick={() => setAllOps(!allOpsSelected)}
                  style={ghostBtn}
                >
                  {allOpsSelected ? 'Limpar' : 'Todas'}
                </button>
              </div>
            </div>
            {error && <p style={{ color: 'var(--accent)', fontSize: 13 }}>{error}</p>}
            {loading ? (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Carregando…</p>
            ) : ops.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Nenhuma operação.</p>
            ) : (
              <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                {ops.map((o) => {
                  const sel = selectedOpIds.has(o.id);
                  const count = agentCountByOp(o.id);
                  return (
                    <div
                      key={o.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        opacity: o.status === OperationStatus.ENCERRADA ? 0.7 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggleOp(o.id)}
                        style={{ accentColor: opColors[o.id], flexShrink: 0, cursor: 'pointer' }}
                        title={sel ? 'Ocultar operação' : 'Exibir operação'}
                      />
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: opColors[o.id] ?? 'var(--muted)',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13 }}>{o.name}</span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {STATUS_LABELS[o.status] ?? o.status}
                        </span>
                      </span>
                      <span className="badge" style={{ flexShrink: 0 }} title="Agentes com posição">
                        {count}
                      </span>
                      <button
                        type="button"
                        onClick={() => focusOp(o.id)}
                        disabled={count === 0}
                        title={count === 0 ? 'Sem agentes com posição' : `Enquadrar ${o.name}`}
                        style={{
                          ...iconBtn,
                          cursor: count === 0 ? 'not-allowed' : 'pointer',
                          opacity: count === 0 ? 0.4 : 1,
                        }}
                      >
                        ⤢
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Equipes: filtro + cor por equipe (Fase 2a). */}
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 14 }}>Equipes ({relevantTeams.length})</strong>
              {relevantTeams.length > 0 && (
                <button
                  type="button"
                  className="badge"
                  style={ghostBtn}
                  onClick={() =>
                    setSelectedTeamIds(
                      selectedTeamIds.size === relevantTeams.length
                        ? new Set()
                        : new Set(relevantTeams.map((t) => t.id)),
                    )
                  }
                >
                  {selectedTeamIds.size === relevantTeams.length ? 'Limpar' : 'Todas'}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 }}>
              <span className="muted">Colorir por:</span>
              {(['agent', 'team'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => pickColorMode(m)}
                  style={{
                    ...ghostBtn,
                    borderRadius: 6,
                    padding: '3px 8px',
                    background: colorMode === m ? 'var(--panel-2)' : 'transparent',
                    borderColor: colorMode === m ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {m === 'agent' ? 'Agente' : 'Equipe'}
                </button>
              ))}
            </div>
            {relevantTeams.length === 0 ? (
              <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                Nenhuma equipe nas operações selecionadas. Crie em <strong>Equipes</strong>.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                {relevantTeams.map((t) => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={selectedTeamIds.has(t.id)}
                      onChange={() => toggleTeam(t.id)}
                      style={{ accentColor: teamColors[t.id], flexShrink: 0, cursor: 'pointer' }}
                      title={selectedTeamIds.has(t.id) ? 'Remover do filtro' : 'Filtrar por esta equipe'}
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                      {t.name}{' '}
                      <span className="muted" style={{ fontSize: 11 }}>
                        · {t.agentIds.length}
                      </span>
                    </span>
                    <ColorPalettePicker
                      value={teamColorOverrides[t.id] ?? t.color}
                      onChange={(token) => setTeamColor(t.id, token)}
                    />
                  </div>
                ))}
              </div>
            )}
            {selectedTeamIds.size > 0 && (
              <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
                Filtro ativo: só agentes das equipes marcadas.
              </p>
            )}
          </div>

          {/* Agentes agrupados por operação */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              margin: '0 0 8px',
            }}
          >
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              Agentes
              <span
                title={liveConnected ? 'Barramento ao vivo conectado' : 'Barramento desconectado'}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: liveConnected ? 'var(--ok)' : 'var(--muted)',
                  boxShadow: liveConnected ? '0 0 6px var(--ok)' : 'none',
                }}
              />
            </h3>
            <Toggle
              checked={showLiveTrail}
              onChange={setShowLiveTrail}
              label="Trilha ao vivo"
              title="Desenha o caminho de cada agente ao vivo, conforme se deslocam"
            />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
            Marcadores e <strong>trilhas</strong> atualizam ao vivo (MQTT). Selecione um agente para
            plotar o histórico de rotas (cor própria); ajuste o período na barra do topo.
          </p>
          {groupOrder.length === 0 && (
            <p className="muted" style={{ fontSize: 13 }}>
              Nenhum agente com posição nas operações selecionadas.
            </p>
          )}
          {groupOrder.map((opId) => {
            const op = opById[opId];
            const agentIds = groups[opId] ?? [];
            const collapsed = collapsedGroups.has(opId);
            const groupRoutes = agentIds.flatMap((a) => (visibleRoutes[a] ?? []).filter(inWindow));
            const groupAllSel =
              groupRoutes.length > 0 && groupRoutes.every((r) => selectedRouteIds.has(r.id));
            return (
              <div key={opId} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    borderBottom: '1px solid var(--border)',
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: opColors[opId],
                      flexShrink: 0,
                    }}
                  />
                  <button type="button" onClick={() => toggleGroup(opId)} style={{ ...linkBtn, flex: 1 }}>
                    <strong style={{ fontSize: 13 }}>{op?.name ?? opId}</strong>{' '}
                    <span className="muted" style={{ fontSize: 12 }}>
                      ({agentIds.length}) {collapsed ? '▸' : '▾'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleOpRoutes(opId)}
                    disabled={groupRoutes.length === 0}
                    className="badge"
                    title="Plotar/ocultar todas as rotas da operação (no período)"
                    style={{
                      ...ghostBtn,
                      cursor: groupRoutes.length === 0 ? 'not-allowed' : 'pointer',
                      opacity: groupRoutes.length === 0 ? 0.4 : 1,
                    }}
                  >
                    {groupAllSel ? 'Ocultar' : 'Plotar'}
                  </button>
                </div>
                {!collapsed &&
                  agentIds.map((agentId) => (
                    <AgentCard
                      key={agentId}
                      agentId={agentId}
                      color={agentColors[agentId] ?? '#c1121f'}
                      colorToken={agentColorOverrides[agentId]}
                      routes={visibleRoutes[agentId] ?? []}
                      otherOps={[...(agentOps.get(agentId)?.opIds ?? [])]
                        .filter((id) => id !== opId)
                        .map((id) => opById[id]?.name ?? id)}
                      selectedRouteIds={selectedRouteIds}
                      inWindow={inWindow}
                      expanded={expandedAgent === agentId}
                      onExpand={() => setExpandedAgent(expandedAgent === agentId ? null : agentId)}
                      onToggleAll={() => toggleAgentRoutes(agentId)}
                      onToggleRoute={toggleRoute}
                      onColor={(t) => setAgentColor(agentId, t)}
                    />
                  ))}
              </div>
            );
          })}
        </ResizableSidebar>

        <main
          style={{ flex: 1, minWidth: 0, position: 'relative' }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setBarHover(e.clientY - rect.top < 72);
          }}
          onMouseLeave={() => setBarHover(false)}
        >
          {dataBounds.first != null && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 5,
                overflow: 'hidden',
                paddingTop: 10,
                paddingBottom: 44,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  margin: '0 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'rgba(20,27,36,0.92)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '8px 14px',
                  boxShadow: '0 6px 16px rgba(0,0,0,.45)',
                  transform: barPinned || barHover ? 'translateY(0)' : 'translateY(-180%)',
                  opacity: barPinned || barHover ? 1 : 0,
                  transition: 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.28s ease',
                  pointerEvents: barPinned || barHover ? 'auto' : 'none',
                }}
              >
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  Período
                </span>
                <span
                  style={{
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 78,
                    textAlign: 'right',
                  }}
                >
                  {fmtDateTime(windowStartMs)}
                </span>
                <PeriodRange
                  min={rangeMin}
                  max={rangeMax}
                  start={windowStartMs}
                  end={windowEndMs}
                  onChange={(s, e) => {
                    setWindowStartMs(s);
                    setWindowEndMs(e);
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 78,
                  }}
                >
                  {fmtDateTime(windowEndMs)}
                </span>
                <button
                  type="button"
                  className="pinbtn"
                  onClick={() => {
                    const v = !barPinned;
                    setBarPinned(v);
                    localStorage.setItem(PIN_KEY, v ? '1' : '0');
                  }}
                  title={barPinned ? 'Desafixar a barra de período' : 'Fixar a barra de período'}
                  aria-pressed={barPinned}
                  style={{ flexShrink: 0, cursor: 'pointer' }}
                >
                  📌
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="maplabelbtn"
            onClick={fitAll}
            title="Enquadrar tudo (rotas plotadas + agentes)"
            style={{
              position: 'absolute',
              bottom: 12,
              left: 12,
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'rgba(20,27,36,0.92)',
              color: 'var(--text)',
              boxShadow: '0 2px 12px rgba(0,0,0,.4)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            <span>⤢</span>
            <span className="maplabel">Enquadrar tudo</span>
          </button>
          <LiveMap
            agents={agents}
            routes={plottedRoutes}
            trails={liveTrailsForMap}
            showTrails={showLiveTrail}
            agentColors={agentColors}
            fitNonce={fitNonce}
            fitPoints={fitPoints}
            showGeofences={false}
          />
        </main>
      </div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
};
const iconBtn: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 6,
  padding: '2px 7px',
  fontSize: 12,
  flexShrink: 0,
};
const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  textAlign: 'left',
  font: 'inherit',
};

/** Card de um agente: cor + seleção de rotas (todas/individuais) — portado da live page. */
function AgentCard({
  agentId,
  color,
  colorToken,
  routes,
  otherOps,
  selectedRouteIds,
  inWindow,
  expanded,
  onExpand,
  onToggleAll,
  onToggleRoute,
  onColor,
}: {
  agentId: string;
  color: string;
  colorToken?: string;
  routes: Route[];
  otherOps: string[];
  selectedRouteIds: Set<string>;
  inWindow: (r: Route) => boolean;
  expanded: boolean;
  onExpand: () => void;
  onToggleAll: () => void;
  onToggleRoute: (id: string) => void;
  onColor: (token: string) => void;
}) {
  const routesInWindow = routes.filter(inWindow);
  const selCount = routesInWindow.filter((r) => selectedRouteIds.has(r.id)).length;
  const allSel = routesInWindow.length > 0 && selCount === routesInWindow.length;
  const anySel = selCount > 0;
  return (
    <div>
      <div
        className="card"
        style={{
          padding: 10,
          marginBottom: expanded ? 0 : 8,
          borderLeft: `3px solid ${color}`,
          boxShadow: anySel ? `0 0 0 1px ${color}` : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={onToggleAll}
            disabled={routesInWindow.length === 0}
            title={
              routesInWindow.length === 0
                ? 'Sem rotas no período atual'
                : allSel
                  ? 'Ocultar as rotas deste agente'
                  : 'Plotar as rotas deste agente'
            }
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              border: `2px solid ${color}`,
              background: allSel ? color : anySel ? `${color}80` : 'transparent',
              cursor: routesInWindow.length === 0 ? 'not-allowed' : 'pointer',
              flexShrink: 0,
              padding: 0,
            }}
          />
          <button type="button" onClick={onExpand} style={{ ...linkBtn, flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <strong>{agentId}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {routes.length} rota{routes.length === 1 ? '' : 's'}
            </span>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              {expanded ? '▾' : '▸'}
            </span>
          </button>
        </div>
        {otherOps.length > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            também em: {otherOps.join(', ')}
          </div>
        )}
      </div>
      {expanded && (
        <div
          className="card"
          style={{ padding: 10, margin: '0 0 8px', borderLeft: `3px solid ${color}`, background: 'var(--bg)' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10,
              paddingBottom: 10,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Cor do agente</span>
            <ColorPalettePicker value={colorToken ?? 'blue'} onChange={onColor} />
          </div>
          {routes.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              Nenhuma rota registrada para este agente.
            </div>
          )}
          {routes.map((r, i) => {
            const outWin = !inWindow(r);
            const sel = selectedRouteIds.has(r.id);
            return (
              <label
                key={r.id}
                title={outWin ? 'Fora do período atual' : 'Exibir/ocultar esta rota no mapa'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  padding: '4px 0',
                  opacity: outWin ? 0.45 : 1,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={sel}
                  onChange={() => onToggleRoute(r.id)}
                  style={{ accentColor: color, flexShrink: 0 }}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtDateTime(r.start)} → {fmtDateTime(r.end)}
                </span>
                <span className="muted" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  #{i + 1} · {r.points.length}p
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
