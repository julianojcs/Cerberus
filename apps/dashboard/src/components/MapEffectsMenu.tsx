'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Toggle } from './Toggle';

/**
 * Um controle do menu de efeitos do mapa. `toggle` = liga/desliga; `number` =
 * campo numérico; `section` = subtítulo agrupador (sem controle).
 */
export type MapEffectControl =
  | {
      kind: 'toggle';
      id: string;
      label: string;
      title?: string;
      checked: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void;
    }
  | {
      kind: 'number';
      id: string;
      label: string;
      title?: string;
      value: number;
      min?: number;
      max?: number;
      step?: number;
      disabled?: boolean;
      onChange: (value: number) => void;
    }
  | { kind: 'section'; id: string; label: string };

/**
 * Menu flutuante de "Efeitos do mapa" — um botão (FAB) no canto inferior direito
 * do mapa que abre um popover com os controles. Genérico: recebe a lista de
 * controles (toggles, campos numéricos, seções) e renderiza cada um (tema escuro,
 * contraste AA). Fecha ao clicar fora ou com Esc. Projetado para crescer.
 */
export function MapEffectsMenu({ controls }: { controls: MapEffectControl[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora do menu ou ao pressionar Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rowStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  };
  const labelStyle: CSSProperties = { fontSize: 13, color: 'var(--text)' };
  const numStyle: CSSProperties = {
    width: 68,
    background: 'var(--bg, #0b0f14)',
    color: 'var(--text, #e6edf3)',
    colorScheme: 'dark',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 13,
    boxSizing: 'border-box',
  };

  return (
    <div ref={rootRef} style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 5 }}>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            bottom: 52,
            minWidth: 250,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'rgba(20,27,36,0.96)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 12,
            boxShadow: '0 6px 20px rgba(0,0,0,.5)',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              marginBottom: 10,
            }}
          >
            Efeitos do mapa
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {controls.map((c) => {
              if (c.kind === 'section') {
                return (
                  <div
                    key={c.id}
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--muted)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.3,
                      borderTop: '1px solid var(--border)',
                      paddingTop: 8,
                      marginTop: 2,
                    }}
                  >
                    {c.label}
                  </div>
                );
              }
              if (c.kind === 'toggle') {
                return (
                  <div key={c.id} style={rowStyle} title={c.title}>
                    <span style={{ ...labelStyle, opacity: c.disabled ? 0.5 : 1 }}>{c.label}</span>
                    <Toggle
                      checked={c.checked}
                      onChange={c.onChange}
                      title={c.title}
                      disabled={c.disabled}
                    />
                  </div>
                );
              }
              return (
                <label key={c.id} style={rowStyle} title={c.title}>
                  <span style={{ ...labelStyle, opacity: c.disabled ? 0.5 : 1 }}>{c.label}</span>
                  <input
                    type="number"
                    min={c.min}
                    max={c.max}
                    step={c.step ?? 1}
                    value={c.value}
                    disabled={c.disabled}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (e.target.value !== '' && Number.isFinite(v)) c.onChange(v);
                    }}
                    style={numStyle}
                  />
                </label>
              );
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label="Efeitos do mapa"
        aria-expanded={open}
        title="Efeitos do mapa"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 40,
          height: 40,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: open ? 'var(--panel-2, #1c2733)' : 'rgba(20,27,36,0.92)',
          color: 'var(--text)',
          boxShadow: '0 2px 12px rgba(0,0,0,.4)',
          cursor: 'pointer',
        }}
      >
        {/* Ícone de camadas — comunica "sobreposições/efeitos do mapa". */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 2 2 7l10 5 10-5-10-5Z" />
          <path d="m2 17 10 5 10-5" />
          <path d="m2 12 10 5 10-5" />
        </svg>
      </button>
    </div>
  );
}
