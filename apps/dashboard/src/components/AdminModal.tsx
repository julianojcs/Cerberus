'use client';

import type { CSSProperties, ReactNode } from 'react';

const ghostBtn: CSSProperties = {
  cursor: 'pointer',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text, #e6edf3)',
};

/** Shell de modal do painel Admin (overlay + painel `.card` + título + fechar). */
export function AdminModal({
  title,
  onClose,
  children,
  width = 460,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      className="animate__animated animate__fadeIn animate__faster"
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
        className="card animate__animated animate__zoomIn animate__faster"
        style={{ width, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', padding: 20 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 16 }}>{title}</strong>
          <button type="button" className="badge" style={ghostBtn} onClick={onClose}>
            Fechar ✕
          </button>
        </div>
        <div style={{ marginTop: 16 }}>{children}</div>
      </div>
    </div>
  );
}
