'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { OperationStatus, Role, type Operation } from '@cerberus/shared';
import { api, type LatestPosition } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { assignAgentColors } from '@/lib/routes';
import { resolveColor } from '@/lib/tailwind-colors';
import { AdminHeader } from '@/components/AdminHeader';
import { GlobalMap, type GlobalAgent } from '@/components/GlobalMap';
import { STATUS_LABELS } from '@/components/OperationFormModal';

const POLL_MS = 12_000;

export default function AdminMapPage() {
  const router = useRouter();
  const [ops, setOps] = useState<Operation[]>([]);
  const [agents, setAgents] = useState<GlobalAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fitPoints, setFitPoints] = useState<[number, number][]>([]);
  const [fitNonce, setFitNonce] = useState(0);
  // Enquadra automaticamente só na primeira leva de dados (evita "pular" a cada poll).
  const firstFitRef = useRef(false);

  // Cor estável por operação (token da paleta → hex), reusada no mapa e na legenda.
  const opColors = useMemo(() => {
    const tokens = assignAgentColors(ops.map((o) => o.id));
    const out: Record<string, string> = {};
    for (const o of ops) out[o.id] = resolveColor(tokens[o.id]);
    return out;
  }, [ops]);
  const opColorsRef = useRef(opColors);
  opColorsRef.current = opColors;

  const load = useCallback(async (opList: Operation[]) => {
    // Fan-out: última posição de cada operação (o SA transcende o escopo). Merge
    // deduplicado por agente, mantendo a posição mais recente entre operações.
    const results = await Promise.allSettled(
      opList.map(async (o) => ({ op: o, positions: await api.latestPositions(o.id) })),
    );
    const byAgent = new Map<string, { agent: GlobalAgent; capturedAt: number }>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { op, positions } = r.value;
      for (const p of positions as LatestPosition[]) {
        if (p.lat == null || p.lng == null) continue;
        const cap = +new Date(p.capturedAt);
        const prev = byAgent.get(p.agentId);
        if (prev && prev.capturedAt >= cap) continue;
        byAgent.set(p.agentId, {
          capturedAt: cap,
          agent: {
            key: p.agentId,
            agentId: p.agentId,
            operationId: op.id,
            operationName: op.name,
            color: opColorsRef.current[op.id] ?? '#c1121f',
            lat: p.lat,
            lng: p.lng,
            battery: p.battery,
            activity: p.activity,
          },
        });
      }
    }
    const next = [...byAgent.values()].map((v) => v.agent);
    setAgents(next);
    // Primeiro enquadre automático: todos os agentes.
    if (!firstFitRef.current && next.length > 0) {
      firstFitRef.current = true;
      setFitPoints(next.map((a) => [a.lng, a.lat] as [number, number]));
      setFitNonce((n) => n + 1);
    }
  }, []);

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
    api
      .operations()
      .then((list) => {
        setOps(list);
        void load(list).catch((e) => setError((e as Error).message));
        timer = setInterval(() => {
          void load(list).catch(() => {});
        }, POLL_MS);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [router, load]);

  // Nº de agentes ativos por operação (na leva atual).
  const countByOp = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of agents) out[a.operationId] = (out[a.operationId] ?? 0) + 1;
    return out;
  }, [agents]);

  function fitAll() {
    if (agents.length === 0) return;
    setFitPoints(agents.map((a) => [a.lng, a.lat] as [number, number]));
    setFitNonce((n) => n + 1);
  }

  function focusOp(opId: string) {
    const pts = agents
      .filter((a) => a.operationId === opId)
      .map((a) => [a.lng, a.lat] as [number, number]);
    if (pts.length === 0) return;
    setFitPoints(pts);
    setFitNonce((n) => n + 1);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AdminHeader active="map" isSA />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          className="thinscroll"
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            overflowY: 'auto',
            padding: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <strong>Operações ({ops.length})</strong>
            <button
              type="button"
              className="badge"
              onClick={fitAll}
              disabled={agents.length === 0}
              title="Enquadrar todos os agentes"
              style={{
                cursor: agents.length === 0 ? 'not-allowed' : 'pointer',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text)',
                opacity: agents.length === 0 ? 0.5 : 1,
              }}
            >
              ⤢ Tudo
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
            {agents.length} agente{agents.length === 1 ? '' : 's'} com posição. Clique numa operação
            para enquadrá-la.
          </p>
          {error && <p style={{ color: 'var(--accent)', fontSize: 13 }}>{error}</p>}
          {loading ? (
            <p className="muted">Carregando…</p>
          ) : ops.length === 0 ? (
            <p className="muted">Nenhuma operação.</p>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {ops.map((o) => {
                const count = countByOp[o.id] ?? 0;
                const encerrada = o.status === OperationStatus.ENCERRADA;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => focusOp(o.id)}
                    disabled={count === 0}
                    title={count === 0 ? 'Sem agentes com posição' : `Enquadrar ${o.name}`}
                    className="card"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: 10,
                      textAlign: 'left',
                      cursor: count === 0 ? 'default' : 'pointer',
                      opacity: encerrada ? 0.6 : 1,
                      borderLeft: `3px solid ${opColors[o.id] ?? 'var(--border)'}`,
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        background: opColors[o.id] ?? 'var(--muted)',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                        {o.name}
                      </span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </span>
                    <span
                      className="badge"
                      style={{ flexShrink: 0 }}
                      title="Agentes com posição"
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
        <main style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <GlobalMap agents={agents} fitPoints={fitPoints} fitNonce={fitNonce} />
        </main>
      </div>
    </div>
  );
}
