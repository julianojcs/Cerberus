'use client';

import { useState } from 'react';
import { api, type Settings } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Toggle } from './Toggle';

/**
 * Modal de Configurações do sistema. Ajustes básicos de exibição das rotas.
 * Leitura para qualquer usuário; a edição (salvar) é restrita a admin — o backend
 * também impõe isso (403), aqui só desabilitamos os controles e avisamos.
 */
export function SettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}) {
  const isAdmin = getUser()?.role === 'admin';
  const [minRoutePoints, setMinRoutePoints] = useState(String(initial.minRoutePoints));
  const [connectRoutes, setConnectRoutes] = useState(initial.connectRoutes);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const min = Number(minRoutePoints);
  const validMin = Number.isInteger(min) && min >= 1 && min <= 1000;

  async function save() {
    if (!validMin) return;
    setSaving(true);
    setMsg(null);
    try {
      const saved = await api.patchSettings({ minRoutePoints: min, connectRoutes });
      onSaved(saved);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: 90,
    background: 'var(--bg, #0b0f14)',
    color: 'var(--text, #e6edf3)',
    border: `1px solid ${validMin ? 'var(--border)' : '#c1121f'}`,
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 420, maxWidth: '92vw', padding: 20 }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <strong style={{ fontSize: 16 }}>⚙ Configurações</strong>
          <button
            type="button"
            onClick={onClose}
            className="badge"
            style={{
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: 'transparent',
            }}
          >
            Fechar ✕
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 16px' }}>
          Ajustes de exibição das rotas dos agentes.
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Pontos mínimos por rota</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Rotas com menos pontos que isso são ocultadas (trechos insignificantes).
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={1000}
            value={minRoutePoints}
            onChange={(e) => setMinRoutePoints(e.target.value)}
            disabled={!isAdmin}
            style={inputStyle}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 14 }}>Ligar rotas</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Desenha uma linha ligando o fim de uma rota ao início da próxima.
            </div>
          </div>
          <Toggle
            checked={connectRoutes}
            onChange={setConnectRoutes}
            title="Ligar o fim de uma rota ao início da próxima"
          />
        </div>

        {!isAdmin && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Apenas administradores podem alterar as configurações.
          </div>
        )}
        {msg && <div style={{ fontSize: 12, marginTop: 8, color: '#c1121f' }}>{msg}</div>}

        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button
              type="button"
              onClick={save}
              disabled={saving || !validMin}
              style={{
                flex: 1,
                padding: 10,
                borderRadius: 8,
                border: 'none',
                background: '#3fb950',
                color: '#0b0f14',
                fontWeight: 700,
                cursor: saving || !validMin ? 'not-allowed' : 'pointer',
                opacity: saving || !validMin ? 0.5 : 1,
              }}
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              type="button"
              onClick={onClose}
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
        )}
      </div>
    </div>
  );
}
