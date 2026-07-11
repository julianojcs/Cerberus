'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TAILWIND_FAMILIES, resolveColor } from '@/lib/tailwind-colors';

/**
 * Seletor de cor PRIMARIA por familia da paleta Tailwind. Um gatilho compacto (a
 * cor atual) abre um POPOVER ancorado com a grade de swatches. O popover vai para
 * o `body` (portal) para não ser recortado pelo overflow do sidebar; fecha ao
 * clicar fora, ao rolar ou com Esc. O valor e o TOKEN da familia (ex.: 'green').
 */
export function ColorPalettePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Abre abaixo do gatilho; se não couber (perto do rodapé), inverte para cima.
      const estHeight = 132; // altura aproximada do popover (3 linhas de swatches)
      const below = rect.bottom + 6;
      const top = below + estHeight > window.innerHeight ? rect.top - estHeight - 6 : below;
      setCoords({ top: Math.max(8, top), left: rect.left });
    }

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Rolar/redimensionar desalinha o popover ancorado — fecha para evitar isso.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Escolher cor"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '4px 8px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: resolveColor(value),
            border: '2px solid #fff',
          }}
        />
        <span className="muted" style={{ fontSize: 11, lineHeight: 1 }}>
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="card animate__animated animate__fadeIn animate__faster"
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              zIndex: 1100,
              padding: 10,
              width: 176,
              boxShadow: '0 8px 20px rgba(0,0,0,.5)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TAILWIND_FAMILIES.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => {
                    onChange(f.name);
                    setOpen(false);
                  }}
                  title={f.name}
                  aria-label={f.name}
                  aria-pressed={value === f.name}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: f.hex,
                    border: '2px solid #fff',
                    outline: value === f.name ? `2px solid ${f.hex}` : '2px solid transparent',
                    outlineOffset: 1,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
