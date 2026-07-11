'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

const ICON_BTN: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 26,
  height: 26,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--muted)',
  padding: 0,
};

function Chevron({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {dir === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}

/** Ícone de painel (recolher/expandir), estilo PanelLeftClose/Open do jmr26. */
function PanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {collapsed ? <path d="M14 9l3 3-3 3" /> : <path d="M16 9l-3 3 3 3" />}
    </svg>
  );
}

/**
 * Sidebar de largura ajustavel — porta o estilo do `ResizableSidebar`/`ScrollableNav`
 * do jmr26 (sem importar do outro repo): barra de rolagem OCULTA, setas ↑/↓ +
 * degrade de fade no overflow, e botao de recolher/expandir. Largura e estado
 * recolhido persistidos em localStorage.
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
  const [collapsed, setCollapsed] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  useEffect(() => {
    const w = Number(localStorage.getItem(storageKey + '-w'));
    if (Number.isFinite(w) && w >= min && w <= max) setWidth(w);
    if (localStorage.getItem(storageKey + '-collapsed') === 'true') setCollapsed(true);
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
      localStorage.setItem(storageKey + '-w', String(widthRef.current));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [storageKey, min, max]);

  // Estado de rolagem (setas + fade), observando tamanho e mutacoes do conteudo.
  const updateScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanUp(el.scrollTop > 2);
    setCanDown(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || collapsed) return;
    updateScroll();
    const ro = new ResizeObserver(updateScroll);
    ro.observe(el);
    const mo = new MutationObserver(updateScroll);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [updateScroll, collapsed]);

  const scrollStep = (dir: 'up' | 'down') =>
    scrollRef.current?.scrollBy({ top: dir === 'up' ? -160 : 160, behavior: 'smooth' });

  const toggleCollapse = () =>
    setCollapsed((c) => {
      localStorage.setItem(storageKey + '-collapsed', String(!c));
      return !c;
    });

  const showArrows = !collapsed && (canUp || canDown);

  return (
    <aside
      ref={asideRef}
      style={{
        width: collapsed ? 44 : width,
        flexShrink: 0,
        position: 'relative',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: dragging.current ? 'none' : 'width 0.2s ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 8px',
          minHeight: 38,
          borderBottom: showArrows ? '1px solid var(--border)' : 'none',
        }}
      >
        {showArrows ? (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              type="button"
              onClick={() => scrollStep('up')}
              disabled={!canUp}
              title="Rolar para cima"
              style={{ ...ICON_BTN, color: canUp ? 'var(--muted)' : 'var(--border)' }}
            >
              <Chevron dir="up" />
            </button>
            <button
              type="button"
              onClick={() => scrollStep('down')}
              disabled={!canDown}
              title="Rolar para baixo"
              style={{ ...ICON_BTN, color: canDown ? 'var(--muted)' : 'var(--border)' }}
            >
              <Chevron dir="down" />
            </button>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={toggleCollapse}
          title={collapsed ? 'Expandir' : 'Recolher'}
          style={{ ...ICON_BTN, marginLeft: 'auto' }}
        >
          <PanelIcon collapsed={collapsed} />
        </button>
      </div>

      {!collapsed && (
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <div
            ref={scrollRef}
            onScroll={updateScroll}
            className="scrollhide"
            style={{ height: '100%', overflowY: 'auto', padding: 16 }}
          >
            {children}
          </div>
          {canUp && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 24,
                background: 'linear-gradient(to bottom, var(--bg), transparent)',
                pointerEvents: 'none',
              }}
            />
          )}
          {canDown && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 24,
                background: 'linear-gradient(to top, var(--bg), transparent)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      )}

      {!collapsed && (
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
      )}
    </aside>
  );
}
