'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  api,
  type LatestPosition,
  type TacticalMessage,
  type Geofence,
  type GeofenceAlert,
} from '@/lib/api';
import { getToken } from '@/lib/auth';
import { subscribeToOperation, type LivePosition } from '@/lib/mqtt';
import { LiveMap, type AgentPoint, type AgentTrails } from '@/components/LiveMap';
import { Toggle } from '@/components/Toggle';
import { AuthImage } from '@/components/AuthImage';
import { ResizableSidebar } from '@/components/ResizableSidebar';
import { ColorPalettePicker } from '@/components/ColorPalettePicker';
import { resolveColor } from '@/lib/tailwind-colors';

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
  const [lightbox, setLightbox] = useState<TacticalMessage | null>(null);

  // Geofencing.
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [alerts, setAlerts] = useState<GeofenceAlert[]>([]);
  const [placing, setPlacing] = useState(false);
  const [pendingCenter, setPendingCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [gfName, setGfName] = useState('');
  const [gfRadius, setGfRadius] = useState('200');
  const [gfColor, setGfColor] = useState('green');
  const [editGeo, setEditGeo] = useState<{
    id: string;
    lng: number;
    lat: number;
    radiusMeters: number;
    color: string;
  } | null>(null);
  const [alertFocus, setAlertFocus] = useState<[number, number] | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

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

    // Overlays (mídia + geofences + alertas): polling leve a cada 15s (o painel
    // não assina o canal de broadcast).
    const loadOverlays = () => {
      api
        .messages(operationId)
        .then((msgs) => setMediaMsgs(msgs.filter((m) => m.type === 'media' && !!m.mediaRef)))
        .catch(() => {});
      api
        .geofences(operationId)
        .then(setGeofences)
        .catch(() => {});
      api
        .alerts(operationId)
        .then(setAlerts)
        .catch(() => {});
    };
    void loadOverlays();
    const overlayTimer = setInterval(loadOverlays, 15000);

    const unsubscribe = subscribeToOperation(
      operationId,
      (pos: LivePosition) => {
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
      setConnected,
    );

    return () => {
      clearInterval(overlayTimer);
      unsubscribe();
    };
  }, [operationId, router]);

  const agentList = useMemo(() => Object.values(agents), [agents]);

  const mediaMarkers = useMemo(
    () =>
      mediaMsgs
        .filter((m) => m.lat != null && m.lng != null)
        .map((m) => ({
          id: m.id,
          lat: m.lat as number,
          lng: m.lng as number,
          senderId: m.senderId,
          caption: m.text,
        })),
    [mediaMsgs],
  );

  // Zonas exibidas no mapa: cor resolvida (familia->hex), valores ao vivo da zona
  // em edicao e preview da nova zona (com a cor escolhida).
  const displayGeofences = useMemo(() => {
    const base = geofences.map((g) => {
      const e = editGeo?.id === g.id ? editGeo : null;
      return {
        id: g.id,
        name: g.name,
        lng: e ? e.lng : g.lng,
        lat: e ? e.lat : g.lat,
        radiusMeters: e ? e.radiusMeters : g.radiusMeters,
        color: resolveColor(e ? e.color : g.color),
      };
    });
    if (!pendingCenter) return base;
    const r = Number(gfRadius);
    return [
      ...base,
      {
        id: '__preview__',
        name: '(nova zona)',
        lng: pendingCenter.lng,
        lat: pendingCenter.lat,
        radiusMeters: Number.isFinite(r) && r > 0 ? r : 100,
        color: resolveColor(gfColor),
      },
    ];
  }, [geofences, pendingCenter, gfRadius, gfColor, editGeo]);

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

  async function handleCreateGeofence() {
    const radius = Number(gfRadius);
    if (!pendingCenter || !gfName.trim() || !Number.isFinite(radius) || radius < 1) return;
    try {
      await api.createGeofence(operationId, {
        name: gfName.trim(),
        lng: pendingCenter.lng,
        lat: pendingCenter.lat,
        radiusMeters: radius,
        color: gfColor,
      });
      setPendingCenter(null);
      setPlacing(false);
      setGfName('');
      setGeofences(await api.geofences(operationId));
    } catch {
      /* criação falhou (ex.: sem permissão) */
    }
  }

  async function handleDeleteGeofence(gid: string) {
    try {
      await api.deleteGeofence(operationId, gid);
      setGeofences((prev) => prev.filter((g) => g.id !== gid));
      if (editGeo?.id === gid) setEditGeo(null);
    } catch {
      /* remoção falhou */
    }
  }

  function startEdit(g: Geofence) {
    setPlacing(false);
    setPendingCenter(null);
    setEditGeo({ id: g.id, lng: g.lng, lat: g.lat, radiusMeters: g.radiusMeters, color: g.color });
  }

  async function saveEdit() {
    if (!editGeo) return;
    try {
      await api.patchGeofence(operationId, editGeo.id, {
        lng: editGeo.lng,
        lat: editGeo.lat,
        radiusMeters: editGeo.radiusMeters,
        color: editGeo.color,
      });
      setGeofences(await api.geofences(operationId));
    } catch {
      /* edição falhou */
    }
    setEditGeo(null);
  }

  async function handleRecompute() {
    setRecomputing(true);
    try {
      await api.recomputeAlerts(operationId);
      setAlerts(await api.alerts(operationId));
    } catch {
      /* recálculo falhou */
    }
    setRecomputing(false);
  }

  const gfInputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg, #0b0f14)',
    color: 'var(--text, #e6edf3)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    boxSizing: 'border-box',
  };

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
        <ResizableSidebar storageKey="cerberus_live_sidebar_w" defaultWidth={260}>
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
                    onClick={() => setLightbox(m)}
                    style={{
                      width: '100%',
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 6,
                      background: 'var(--border)',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 14 }}>Zonas ({geofences.length})</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Toggle
                  checked={showZones}
                  onChange={setShowZones}
                  label="Exibir"
                  title="Exibir/ocultar as zonas no mapa"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPlacing((p) => !p);
                    setPendingCenter(null);
                  }}
                  className="badge"
                  style={{
                    cursor: 'pointer',
                    border: '1px solid var(--border)',
                    background: placing ? '#3fb950' : 'transparent',
                    color: placing ? '#0b0f14' : 'var(--muted)',
                  }}
                >
                  {placing ? 'clique no mapa…' : '+ Nova'}
                </button>
              </div>
            </div>
            {pendingCenter && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={gfName}
                  onChange={(e) => setGfName(e.target.value)}
                  placeholder="Nome da zona"
                  style={gfInputStyle}
                />
                <input
                  type="number"
                  value={gfRadius}
                  onChange={(e) => setGfRadius(e.target.value)}
                  placeholder="Raio (m)"
                  style={gfInputStyle}
                />
                <ColorPalettePicker value={gfColor} onChange={setGfColor} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={handleCreateGeofence}
                    disabled={!gfName.trim()}
                    title={!gfName.trim() ? 'Informe um nome para a zona' : 'Criar zona'}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 6,
                      border: 'none',
                      background: '#3fb950',
                      color: '#0b0f14',
                      fontWeight: 700,
                      cursor: gfName.trim() ? 'pointer' : 'not-allowed',
                      opacity: gfName.trim() ? 1 : 0.5,
                    }}
                  >
                    Criar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingCenter(null);
                      setPlacing(false);
                    }}
                    className="badge"
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            {geofences.map((g) => (
              <div
                key={g.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 8,
                  fontSize: 13,
                }}
              >
                <span style={{ color: editGeo?.id === g.id ? 'var(--ok)' : undefined }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: resolveColor(editGeo?.id === g.id ? editGeo.color : g.color),
                      marginRight: 6,
                      verticalAlign: 'middle',
                    }}
                  />
                  {g.name} · {editGeo?.id === g.id ? editGeo.radiusMeters : g.radiusMeters} m
                </span>
                <span style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => startEdit(g)}
                    title="Editar (mover/redimensionar)"
                    style={{
                      cursor: 'pointer',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteGeofence(g.id)}
                    title="Remover"
                    style={{
                      cursor: 'pointer',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
            {editGeo && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Arraste o <strong>centro</strong> (mover) ou a <strong>borda</strong>{' '}
                  (redimensionar). Raio: {editGeo.radiusMeters} m
                </div>
                <div style={{ marginTop: 8 }}>
                  <ColorPalettePicker
                    value={editGeo.color}
                    onChange={(c) => setEditGeo((e) => (e ? { ...e, color: c } : e))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={saveEdit}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 6,
                      border: 'none',
                      background: '#3fb950',
                      color: '#0b0f14',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Salvar
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditGeo(null)}
                    className="badge"
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleRecompute}
              disabled={recomputing}
              title="Reprocessa o histórico de posições e regenera os alertas de entrada/saída"
              className="badge"
              style={{
                marginTop: 10,
                width: '100%',
                cursor: recomputing ? 'wait' : 'pointer',
                border: '1px solid var(--border)',
                background: 'transparent',
              }}
            >
              {recomputing ? 'Recalculando…' : '↻ Recalcular alertas do histórico'}
            </button>
          </div>

          {alerts.length > 0 && (
            <div className="card" style={{ padding: 12, marginBottom: 16 }}>
              <strong style={{ fontSize: 14 }}>Alertas ({alerts.length})</strong>
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4 }}>
                {alerts.map((a) => {
                  const hasLoc = a.lng != null && a.lat != null;
                  return (
                    <div
                      key={a.id}
                      className="muted"
                      onClick={() => hasLoc && setAlertFocus([a.lng as number, a.lat as number])}
                      title={hasLoc ? 'Ver no mapa' : undefined}
                      style={{
                        fontSize: 13,
                        marginTop: 6,
                        cursor: hasLoc ? 'pointer' : 'default',
                      }}
                    >
                      <span style={{ color: a.type === 'enter' ? 'var(--ok)' : '#e3b341' }}>
                        {a.type === 'enter' ? '⊕' : '⊖'}
                      </span>{' '}
                      {a.agentId} {a.type === 'enter' ? 'entrou em' : 'saiu de'}{' '}
                      <strong>{a.geofenceName}</strong>
                    </div>
                  );
                })}
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
        </ResizableSidebar>

        <main style={{ flex: 1, minWidth: 0 }}>
          <LiveMap
            agents={agents}
            trails={trails}
            showTrails={showTrails}
            mediaMarkers={mediaMarkers}
            onMediaClick={(id) => setLightbox(mediaMsgs.find((m) => m.id === id) ?? null)}
            geofences={displayGeofences}
            showGeofences={showZones}
            onMapClick={(lng, lat) => {
              if (placing) setPendingCenter({ lng, lat });
            }}
            editGeofence={editGeo}
            onGeofenceMove={(lng, lat) => setEditGeo((e) => (e ? { ...e, lng, lat } : e))}
            onGeofenceResize={(radiusMeters) => setEditGeo((e) => (e ? { ...e, radiusMeters } : e))}
            focusPoint={alertFocus}
          />
        </main>
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '92vw' }}
          >
            <AuthImage
              path={api.mediaPath(operationId, lightbox.mediaRef!)}
              alt={lightbox.text ?? 'mídia'}
              style={{
                maxWidth: '92vw',
                maxHeight: '80vh',
                objectFit: 'contain',
                borderRadius: 8,
                background: '#141b24',
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 16,
                color: '#fff',
              }}
            >
              <div style={{ fontSize: 14 }}>
                {lightbox.text && <div>{lightbox.text}</div>}
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {lightbox.senderId}
                  {lightbox.lat != null &&
                    ` · 📍 ${lightbox.lat.toFixed(5)}, ${lightbox.lng?.toFixed(5)}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLightbox(null)}
                className="badge"
                style={{
                  cursor: 'pointer',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                Fechar ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
