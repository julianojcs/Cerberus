'use client';

import { useState } from 'react';
import type { GeocodeResult, RouteInfo } from '@cerberus/shared';

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
  /** Endereço do ponto marcado (geocodificação reversa). Ausente ⇒ mostra a coordenada. */
  pendingDestinationLabel?: string | null;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  onDispatch: (input: { agentId: string; lat: number; lng: number; label?: string }) => Promise<void>;
  onCancelRoute: (routeId: string) => Promise<void>;
  onFocusRoute?: (route: RouteInfo) => void;
  /** Busca de endereço. A página injeta para o painel não conhecer o cliente de API. */
  onSearchAddress: (query: string) => Promise<GeocodeResult[]>;
  /** Resultado escolhido vira o destino pendente (a página é dona desse estado). */
  onPickResult: (result: GeocodeResult) => void;
}

export function RouteDispatchPanel({
  agentIds,
  agentColors,
  routes,
  pendingDestination,
  pendingDestinationLabel,
  picking,
  onPickingChange,
  onDispatch,
  onCancelRoute,
  onFocusRoute,
  onSearchAddress,
  onPickResult,
}: RouteDispatchPanelProps) {
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Busca de endereço. `results === null` distingue "ainda não buscou" de "buscou e não
  // achou nada" — sem isso a lista vazia apareceria como erro logo ao abrir o painel.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  /**
   * Dispara só ao SUBMETER, nunca a cada tecla. A política de uso do Nominatim proíbe
   * busca por digitação — não transformar isto em autocomplete com debounce.
   */
  async function runSearch() {
    const q = query.trim();
    if (q.length < 3 || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await onSearchAddress(q));
    } catch (err) {
      setResults(null);
      setSearchError(err instanceof Error ? err.message : 'Falha na busca de endereço');
    } finally {
      setSearching(false);
    }
  }

  function pickResult(result: GeocodeResult) {
    onPickResult(result);
    // O endereço vira o rótulo da rota: é o que a central lê depois no painel.
    setLabel(result.label);
    setResults(null);
    setQuery('');
  }

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
          {/* Busca por endereço — segundo caminho de entrada, ao lado do clique no mapa. */}
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 12,
                  color: 'var(--muted)',
                  pointerEvents: 'none',
                }}
              >
                🔍
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runSearch();
                  }
                }}
                placeholder="Buscar endereço…"
                maxLength={200}
                style={{
                  width: '100%',
                  padding: '6px 26px 6px 26px',
                  borderRadius: 6,
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  border: '1px solid var(--panel-2)',
                }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setResults(null);
                    setSearchError(null);
                  }}
                  title="Limpar"
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    color: 'var(--text)',
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={query.trim().length < 3 || searching}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 12,
                border: '1px solid var(--panel-2)',
                background: 'transparent',
                cursor: query.trim().length < 3 || searching ? 'not-allowed' : 'pointer',
                color: query.trim().length < 3 ? 'var(--muted)' : 'var(--text)',
              }}
            >
              {searching ? '…' : 'Buscar'}
            </button>
          </div>

          {searchError && <span style={{ fontSize: 12, color: '#ff7b72' }}>{searchError}</span>}
          {results !== null && results.length === 0 && !searching && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Nenhum endereço encontrado.
            </span>
          )}
          {results !== null && results.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
              {results.map((r) => (
                <li key={`${r.lat},${r.lng},${r.label}`}>
                  {/* Duas linhas por resultado, como nos apps de navegação: via em
                      destaque, localidade abaixo em tom secundário. */}
                  <button
                    type="button"
                    onClick={() => pickResult(r)}
                    style={{
                      display: 'grid',
                      gap: 1,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: 'none',
                      background: 'var(--bg)',
                      cursor: 'pointer',
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ fontSize: 13 }}>📍 {r.title}</span>
                    {r.subtitle && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 18 }}>
                        {r.subtitle}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {pendingDestination
              ? `Destino: ${
                  pendingDestinationLabel ??
                  `${pendingDestination.lat.toFixed(5)}, ${pendingDestination.lng.toFixed(5)}`
                }`
              : 'Busque um endereço acima ou clique no mapa para marcar o destino.'}
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
