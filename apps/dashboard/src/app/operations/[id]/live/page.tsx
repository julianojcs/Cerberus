'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, type LatestPosition, type TacticalMessage } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { subscribeToOperation, type LivePosition } from '@/lib/mqtt';
import { LiveMap, type AgentPoint, type AgentTrails } from '@/components/LiveMap';
import { Toggle } from '@/components/Toggle';
import { AuthImage } from '@/components/AuthImage';

/** Máximo de pontos por agente na trilha (limita memória/render). */
const MAX_TRAIL = 500;

export default function LiveOperationPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const operationId = params.id;

  const [agents, setAgents] = useState<Record<string, AgentPoint>>({});
  const [trails, setTrails] = useState<AgentTrails>({});
  const [showTrails, setShowTrails] = useState(true);
  const [connected, setConnected] = useState(false);
  const lastUpdateRef = useRef<Record<string, string>>({});
  const [, forceTick] = useState(0);

  // Composer de broadcast (central → agentes).
  const [broadcastText, setBroadcastText] = useState('');
  const [sending, setSending] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState<string | null>(null);

  // Mídia (fotos) enviadas pelos agentes.
  const [mediaMsgs, setMediaMsgs] = useState<TacticalMessage[]>([]);

  // Snapshot inicial (última posição conhecida) via REST + stream ao vivo via MQTT.
  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    api
      .latestPositions(operationId)
      .then((positions: LatestPosition[]) => {
        setAgents((prev) => {
          const next = { ...prev };
          for (const p of positions) {
            next[p.agentId] = {
              agentId: p.agentId,
              lat: p.lat,
              lng: p.lng,
              heading: p.heading,
              battery: p.battery,
              activity: p.activity,
            };
            lastUpdateRef.current[p.agentId] = p.capturedAt;
          }
          return next;
        });
      })
      .catch(() => {
        /* sem histórico ainda */
      });

    // Semeia as trilhas com o histórico (vem do mais recente para o mais antigo).
    api
      .positionHistory(operationId)
      .then((positions: LatestPosition[]) => {
        const byAgent: AgentTrails = {};
        for (let i = positions.length - 1; i >= 0; i--) {
          const p = positions[i];
          if (p.lat == null || p.lng == null) continue;
          (byAgent[p.agentId] ??= []).push([p.lng, p.lat]);
        }
        for (const id of Object.keys(byAgent)) byAgent[id] = byAgent[id].slice(-MAX_TRAIL);
        setTrails(byAgent);
      })
      .catch(() => {
        /* sem histórico ainda */
      });

    // Mídia: carrega o histórico e faz um polling leve (o painel não assina o
    // canal de broadcast; refaz a cada 15s para refletir novas fotos).
    const loadMedia = () =>
      api
        .messages(operationId)
        .then((msgs) => setMediaMsgs(msgs.filter((m) => m.type === 'media' && !!m.mediaRef)))
        .catch(() => {});
    void loadMedia();
    const mediaTimer = setInterval(loadMedia, 15000);

    const unsubscribe = subscribeToOperation(
      operationId,
      (pos: LivePosition) => {
        setConnected(true);
        setAgents((prev) => ({
          ...prev,
          [pos.agentId]: {
            agentId: pos.agentId,
            lat: pos.lat,
            lng: pos.lng,
            heading: pos.heading,
            battery: pos.battery,
            activity: pos.activity,
          },
        }));
        setTrails((prev) => {
          const existing = prev[pos.agentId] ?? [];
          const nextTrail = [...existing, [pos.lng, pos.lat] as [number, number]].slice(-MAX_TRAIL);
          return { ...prev, [pos.agentId]: nextTrail };
        });
        lastUpdateRef.current[pos.agentId] = pos.capturedAt;
        forceTick((t) => t + 1);
      },
      getToken() ?? undefined,
    );

    return () => {
      clearInterval(mediaTimer);
      unsubscribe();
    };
  }, [operationId, router]);

  const agentList = useMemo(() => Object.values(agents), [agents]);

  async function sendBroadcast() {
    const text = broadcastText.trim();
    if (!text) return;
    setSending(true);
    setBroadcastMsg(null);
    try {
      await api.broadcast(operationId, text);
      setBroadcastText('');
      setBroadcastMsg('Broadcast enviado ✓');
    } catch (e) {
      setBroadcastMsg(e instanceof Error ? e.message : 'Falha ao enviar');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/operations" className="badge">
            ← Operações
          </Link>
          <div className="brand">
            <span className="brand-dot" />
            Monitoramento ao vivo
          </div>
          <Link href={`/operations/${operationId}/replay`} className="badge">
            Replay ↺
          </Link>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Toggle
            checked={showTrails}
            onChange={setShowTrails}
            label="Rota"
            title="Exibir/ocultar a rota (percurso) no mapa"
          />
          <span className="badge" style={{ color: connected ? 'var(--ok)' : 'var(--muted)' }}>
            {connected ? '● barramento conectado' : '○ aguardando telemetria'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: 260,
            borderRight: '1px solid var(--border)',
            padding: 16,
            overflowY: 'auto',
          }}
        >
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <strong style={{ fontSize: 14 }}>Broadcast à operação</strong>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
              Diretiva da central para todos os agentes.
            </p>
            <textarea
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="Ex.: Recolher ao ponto de encontro."
              rows={3}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void sendBroadcast();
              }}
              style={{
                width: '100%',
                resize: 'vertical',
                background: 'var(--bg, #0b0f14)',
                color: 'var(--text, #e6edf3)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 8,
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="button"
              onClick={() => void sendBroadcast()}
              disabled={sending || !broadcastText.trim()}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '8px 0',
                borderRadius: 8,
                border: 'none',
                background: '#c1121f',
                color: '#fff',
                fontWeight: 700,
                cursor: sending || !broadcastText.trim() ? 'not-allowed' : 'pointer',
                opacity: sending || !broadcastText.trim() ? 0.5 : 1,
              }}
            >
              {sending ? 'Enviando…' : 'Enviar broadcast'}
            </button>
            {broadcastMsg && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {broadcastMsg}
              </div>
            )}
          </div>

          {mediaMsgs.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 16 }}>
              <strong style={{ fontSize: 14 }}>Mídia da operação ({mediaMsgs.length})</strong>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {mediaMsgs.map((m) => (
                  <AuthImage
                    key={m.id}
                    path={api.mediaPath(operationId, m.mediaRef!)}
                    alt={`Mídia de ${m.senderId}`}
                    style={{
                      width: '100%',
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 6,
                      background: 'var(--border)',
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <h3 style={{ marginTop: 0 }}>Agentes ({agentList.length})</h3>
          {agentList.length === 0 && (
            <p className="muted" style={{ fontSize: 14 }}>
              Nenhuma posição recebida. Simule com o publish-fake-position.
            </p>
          )}
          {agentList.map((a) => (
            <div key={a.agentId} className="card" style={{ padding: 12, marginBottom: 10 }}>
              <strong>{a.agentId}</strong>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                bateria: {a.battery != null ? Math.round(a.battery * 100) + '%' : '—'} ·{' '}
                {a.activity ?? '—'}
              </div>
            </div>
          ))}
        </aside>

        <main style={{ flex: 1, minWidth: 0 }}>
          <LiveMap agents={agents} trails={trails} showTrails={showTrails} />
        </main>
      </div>
    </div>
  );
}
