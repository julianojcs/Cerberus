'use client';

/**
 * Controle da simulação pelo dashboard (issue #134) — Iniciar / Pausar / Parar, sem
 * terminal. Aparece SÓ quando a API autoriza: as três travas (flag de ambiente, nome da
 * operação === SIMULAÇÃO, papel admin) vivem no servidor, e o primeiro GET funciona de
 * gate — se recusar (403/404), o componente não renderiza nada. Assim uma operação real
 * nunca mostra o botão, mesmo que alguém monte este componente por engano.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Square, FlaskConical } from 'lucide-react';
import { api, type SimulationStatus } from '@/lib/api';

type Phase = 'checking' | 'unavailable' | 'ready';

export function SimulationControl({ operationId }: { operationId: string }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.simulationStatus(operationId);
      if (!mounted.current) return;
      setStatus(s);
      setPhase('ready');
    } catch {
      // 403/404 = não autorizado nesta operação (ou feature desligada) → some.
      if (mounted.current) setPhase('unavailable');
    }
  }, [operationId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Enquanto disponível, sonda o estado (outro operador pode ter iniciado/parado).
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const act = useCallback(
    async (fn: (op: string) => Promise<SimulationStatus>) => {
      setBusy(true);
      try {
        const s = await fn(operationId);
        if (mounted.current) setStatus(s);
      } catch {
        void refresh(); // recupera o estado real do servidor
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [operationId, refresh],
  );

  if (phase !== 'ready' || !status) return null;

  const running = status.running;
  const paused = status.paused;
  const label = !running
    ? 'Parada'
    : paused
      ? 'Pausada'
      : `Rodando · ${status.agentIds.length} agentes`;
  const dot = !running ? 'var(--muted)' : paused ? '#c9a227' : 'var(--ok)';

  return (
    <div className="card" style={{ padding: 12, marginTop: 12, borderLeft: '3px solid #8957e5' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <FlaskConical size={16} color="#a371f7" aria-hidden />
        <strong style={{ fontSize: 14 }}>Simulação</strong>
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
          {label}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!running || paused ? (
          <button
            type="button"
            onClick={() => void act(api.startSimulation)}
            disabled={busy}
            style={btn('#238636', '#fff', busy)}
          >
            <Play size={14} aria-hidden /> {paused ? 'Retomar' : 'Iniciar'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void act(api.pauseSimulation)}
            disabled={busy}
            style={btn('#9e6a03', '#fff', busy)}
          >
            <Pause size={14} aria-hidden /> Pausar
          </button>
        )}
        {running && (
          <button
            type="button"
            onClick={() => void act(api.stopSimulation)}
            disabled={busy}
            style={btn('var(--accent)', '#fff', busy)}
          >
            <Square size={14} aria-hidden /> Parar
          </button>
        )}
      </div>

      <p className="muted" style={{ fontSize: 11, margin: '8px 0 0' }}>
        Move os agentes AG-SIM pelas ruas, sem celular. Ferramenta de teste — só nesta operação.
      </p>
    </div>
  );
}

/** Botão sólido com cor de texto EXPLÍCITA (regra ui-contrast: nunca depender do UA). */
function btn(bg: string, color: string, disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 6,
    border: 'none',
    background: bg,
    color,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
