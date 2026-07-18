'use client';

import { useState } from 'react';
import type { RouteInfo } from '@cerberus/shared';

/**
 * Despacho de destino e acompanhamento das rotas ativas (issue #131).
 *
 * Vive num componente próprio porque a live page já é enorme; aqui fica só o fluxo
 * "escolher agente → marcar destino no mapa → despachar" e a lista do que está em
 * curso. O modo de marcação é controlado pela página (ela é quem recebe o clique do
 * mapa) — este painel só liga/desliga o modo e recebe o ponto escolhido.
 */

/** Distância em pt-BR — espelha `formatDistance` da API para o operador ler igual. */
function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';
  if (meters < 1000) {
    const rounded = meters < 20 ? Math.round(meters) : Math.round(meters / 10) * 10;
    return `${rounded} m`;
  }
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

export interface RouteDispatchPanelProps {
  /** Agentes disponíveis para receber rota (os que já reportaram posição). */
  agentIds: string[];
  agentColors: Record<string, string>;
  routes: RouteInfo[];
  /** Ponto marcado no mapa enquanto o modo de destino está ligado. */
  pendingDestination: { lng: number; lat: number } | null;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  onDispatch: (input: { agentId: string; lat: number; lng: number; label?: string }) => Promise<void>;
  onCancelRoute: (routeId: string) => Promise<void>;
  onFocusRoute?: (route: RouteInfo) => void;
}

export function RouteDispatchPanel({
  agentIds,
  agentColors,
  routes,
  pendingDestination,
  picking,
  onPickingChange,
  onDispatch,
  onCancelRoute,
  onFocusRoute,
}: RouteDispatchPanelProps) {
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDispatch = !!agentId && !!pendingDestination && !busy;

  async function dispatch() {
    if (!canDispatch || !pendingDestination) return;
    setBusy(true);
    setError(null);
    try {
      await onDispatch({
        agentId,
        lat: pendingDestination.lat,
        lng: pendingDestination.lng,
        label: label.trim() || undefined,
      });
      setLabel('');
      onPickingChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao despachar a rota');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Rotas</strong>
        <button
          type="button"
          onClick={() => onPickingChange(!picking)}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 12,
            cursor: 'pointer',
            border: `1px solid ${picking ? 'var(--accent)' : 'var(--panel-2)'}`,
            background: picking ? 'var(--accent)' : 'transparent',
            // Botão ativo é vermelho institucional: texto branco. Inativo herda
            // --text pelo `color: inherit` global (ver .claude/rules/ui-contrast.md).
            color: picking ? '#fff' : 'var(--text)',
          }}
        >
          {picking ? 'Cancelar marcação' : 'Definir destino'}
        </button>
      </div>

      {picking && (
        <div
          style={{
            display: 'grid',
            gap: 8,
            padding: 10,
            borderRadius: 8,
            background: 'var(--panel-2)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {pendingDestination
              ? `Destino: ${pendingDestination.lat.toFixed(5)}, ${pendingDestination.lng.toFixed(5)}`
              : 'Clique no mapa para marcar o destino.'}
          </span>

          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--panel-2)',
              colorScheme: 'dark',
            }}
          >
            <option value="">Selecione o agente…</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>

          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Rótulo do destino (opcional)"
            maxLength={120}
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--panel-2)',
            }}
          />

          <button
            type="button"
            onClick={dispatch}
            disabled={!canDispatch}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              border: 'none',
              cursor: canDispatch ? 'pointer' : 'not-allowed',
              background: canDispatch ? 'var(--accent)' : 'var(--panel-2)',
              color: canDispatch ? '#fff' : 'var(--muted)',
            }}
          >
            {busy ? 'Traçando…' : 'Despachar rota'}
          </button>

          {error && <span style={{ fontSize: 12, color: '#ff7b72' }}>{error}</span>}
        </div>
      )}

      {routes.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Nenhuma rota ativa.</span>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {routes.map((r) => (
            <li
              key={r.id}
              style={{
                display: 'grid',
                gap: 2,
                padding: 8,
                borderRadius: 8,
                background: 'var(--panel-2)',
                borderLeft: `3px solid ${agentColors[r.agentId] ?? 'var(--accent)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => onFocusRoute?.(r)}
                  title="Centralizar no destino"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    color: 'var(--text)',
                  }}
                >
                  {r.agentId}
                </button>
                <button
                  type="button"
                  onClick={() => void onCancelRoute(r.id)}
                  title="Cancelar rota"
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: '1px solid var(--panel)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                    color: 'var(--text)',
                  }}
                >
                  Cancelar
                </button>
              </div>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {r.destination.label ?? 'Destino sem rótulo'} · {formatDistance(r.distanceMeters)} ·{' '}
                {formatDuration(r.durationSec)}
              </span>
              {r.fallback && (
                // O operador precisa saber que a linha não segue as vias — senão vai
                // cobrar do agente um trajeto que a rota nunca calculou.
                <span style={{ fontSize: 11, color: '#d29922' }}>
                  Traçado direto: serviço de rotas indisponível no cálculo.
                </span>
              )}
              {r.recalculatedFrom && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Recalculada após desvio.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
