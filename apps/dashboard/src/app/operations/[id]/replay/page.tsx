'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, type LatestPosition } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { LiveMap, type AgentPoint, type AgentTrails } from '@/components/LiveMap';

const SPEEDS = [10, 60, 300];
const TICK_MS = 200; // intervalo real entre passos da reprodução

function fmt(ms: number): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ms));
}

/**
 * Replay histórico de rotas (Fase 4). Carrega o histórico da operação e reproduz
 * o deslocamento dos agentes ao longo do tempo, com controle de play/pause,
 * velocidade e uma barra de tempo (scrubber). Reaproveita o LiveMap alimentando-o
 * com o estado (posições + trilhas) até o instante corrente da reprodução.
 */
export default function ReplayPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const operationId = params.id;

  const [history, setHistory] = useState<LatestPosition[]>([]); // ordenado por tempo (asc)
  const [t, setT] = useState(0); // instante corrente (ms desde epoch)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api
      .positionHistory(operationId, 5000)
      .then((pos) => {
        const asc = pos
          .filter((p) => p.lat != null && p.lng != null)
          .sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt));
        setHistory(asc);
        if (asc.length) setT(+new Date(asc[0].capturedAt));
      })
      .catch(() => {
        /* sem histórico */
      })
      .finally(() => setLoading(false));
  }, [operationId, router]);

  const [t0, tN] = useMemo<[number, number]>(() => {
    if (!history.length) return [0, 0];
    return [+new Date(history[0].capturedAt), +new Date(history[history.length - 1].capturedAt)];
  }, [history]);

  // Loop de reprodução: avança `speed * TICK_MS` ms de dados a cada TICK_MS reais.
  useEffect(() => {
    if (!playing || history.length === 0) return;
    const id = setInterval(() => {
      setT((cur) => {
        const next = cur + speed * TICK_MS;
        if (next >= tN) {
          setPlaying(false);
          return tN;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, tN, history.length]);

  // Estado do mapa (posições correntes + trilhas) até o instante `t`.
  const { agents, trails } = useMemo(() => {
    const agents: Record<string, AgentPoint> = {};
    const trails: AgentTrails = {};
    for (const p of history) {
      if (+new Date(p.capturedAt) > t) break; // history é asc
      agents[p.agentId] = {
        agentId: p.agentId,
        lat: p.lat,
        lng: p.lng,
        heading: p.heading,
        battery: p.battery,
        activity: p.activity,
      };
      (trails[p.agentId] ??= []).push([p.lng, p.lat]);
    }
    return { agents, trails };
  }, [history, t]);

  const atEnd = t >= tN && tN > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href={`/operations/${operationId}/live`} className="badge">
            ← Ao vivo
          </Link>
          <div className="brand">
            <span className="brand-dot" />
            Replay histórico
          </div>
        </div>
        <span className="badge" style={{ color: 'var(--muted)' }}>
          {loading ? 'carregando…' : `${history.length} posição(ões)`}
        </span>
      </div>

      <main style={{ flex: 1, minHeight: 0 }}>
        <LiveMap agents={agents} trails={trails} showTrails />
      </main>

      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (atEnd) setT(t0);
            setPlaying((p) => !p);
          }}
          disabled={history.length === 0}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: 'none',
            background: '#c1121f',
            color: '#fff',
            fontSize: 18,
            cursor: history.length === 0 ? 'not-allowed' : 'pointer',
            opacity: history.length === 0 ? 0.5 : 1,
            flexShrink: 0,
          }}
          aria-label={playing ? 'Pausar' : 'Reproduzir'}
        >
          {playing ? '❚❚' : atEnd ? '↻' : '▶'}
        </button>

        <input
          type="range"
          min={t0}
          max={tN || 1}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          disabled={history.length === 0}
          style={{ flex: 1, minWidth: 160, accentColor: '#c1121f' }}
        />

        <span
          className="muted"
          style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', minWidth: 150 }}
        >
          {fmt(t)}
        </span>

        <div style={{ display: 'flex', gap: 4 }}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className="badge"
              style={{
                cursor: 'pointer',
                border: '1px solid var(--border)',
                background: speed === s ? '#c1121f' : 'transparent',
                color: speed === s ? '#fff' : 'var(--muted)',
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
