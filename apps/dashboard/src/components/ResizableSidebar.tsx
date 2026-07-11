'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Sidebar de largura ajustavel por arraste da borda direita, persistida em
 * localStorage. Porta o conceito do `ResizableSidebar` do JMR26 para o Cerberus
 * (sem importar do outro repo). O conteudo rola verticalmente.
 */
export function ResizableSidebar({
  children,
  storageKey,
  defaultWidth = 260,
  min = 220,
  max = 560,
}: {
  children: ReactNode;
  storageKey: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const asideRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) setWidth(saved);
  }, [storageKey, min, max]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !asideRef.current) return;
      const left = asideRef.current.getBoundingClientRect().left;
      setWidth(Math.min(max, Math.max(min, e.clientX - left)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(storageKey, String(widthRef.current));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [storageKey, min, max]);

  return (
    <aside
      ref={asideRef}
      style={{
        width,
        flexShrink: 0,
        position: 'relative',
        borderRight: '1px solid var(--border)',
        display: 'flex',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>{children}</div>
      <div
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        title="Arraste para ajustar a largura"
        style={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 6,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 5,
        }}
      />
    </aside>
  );
}
