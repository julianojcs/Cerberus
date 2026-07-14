'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '@/lib/api';
import { bytesToObjectUrl, formatBytes, loadDecryptedBytes } from '@/lib/media';

/** Item de mídia exibível no viewer (subconjunto do que a live page já decifra). */
export interface MediaItem {
  id: string;
  mediaRef: string;
  mime: string;
  crypto: { k: string; n: string } | null;
  caption?: string | null;
  senderId: string;
  capturedAt: string;
  lat?: number;
  lng?: number;
}

const SPEEDS = [3, 5, 8]; // segundos por slide

const fmtDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * Image Viewer (Fase 6a): visor em tela cheia sobre a galeria E2EE. Navega entre as
 * fotos (‹ ›, setas do teclado), baixa a imagem decifrada, mostra um painel de
 * informações (remetente, data, formato, dimensões, tamanho, localização) e um
 * slideshow player. Tudo no cliente — a mídia já vem decifrada (ver lib/media).
 */
export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
  operationId,
  nameOf,
  extraInfo,
  actions,
}: {
  items: MediaItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  operationId: string;
  nameOf: (senderId: string) => string;
  /** Linhas extras no painel de info (ex.: 👁 visualizações — Fase 6b). */
  extraInfo?: (item: MediaItem) => React.ReactNode;
  /** Ações no topo (ex.: ⭐ favoritar — Fase 6b). */
  actions?: (item: MediaItem) => React.ReactNode;
}) {
  const item = items[index];
  const [url, setUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const urlRef = useRef<string | null>(null);

  const next = useCallback(
    () => items.length > 0 && onIndex((index + 1) % items.length),
    [index, items.length, onIndex],
  );
  const prev = useCallback(
    () => items.length > 0 && onIndex((index - 1 + items.length) % items.length),
    [index, items.length, onIndex],
  );

  // Carrega/decifra a mídia atual.
  useEffect(() => {
    if (!item?.crypto) {
      setError(true);
      return;
    }
    let active = true;
    let obj: string | null = null;
    setUrl(null);
    setBytes(null);
    setDims(null);
    setError(false);
    loadDecryptedBytes(api.mediaPath(operationId, item.mediaRef), item.crypto.k, item.crypto.n)
      .then((b) => {
        if (!active) return;
        obj = bytesToObjectUrl(b, item.mime);
        urlRef.current = obj;
        setBytes(b.byteLength);
        setUrl(obj);
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [item?.id, item?.mediaRef, item?.crypto, item?.mime, operationId]);

  // Teclado: ← → navega, Esc fecha, i alterna info, espaço play/pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'Escape') onClose();
      else if (e.key.toLowerCase() === 'i') setShowInfo((s) => !s);
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onClose]);

  // Slideshow.
  useEffect(() => {
    if (!playing || items.length < 2) return;
    const t = setInterval(next, (SPEEDS[speedIdx] ?? 3) * 1000);
    return () => clearInterval(t);
  }, [playing, speedIdx, next, items.length]);

  function download() {
    const u = urlRef.current;
    if (!u || !item) return;
    const a = document.createElement('a');
    a.href = u;
    const ext = (item.mime.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
    a.download = `cerberus-${item.capturedAt.slice(0, 10)}-${item.id.slice(-6)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (!item) return null;

  return (
    <div
      onClick={onClose}
      className="animate__animated animate__fadeIn animate__faster"
      style={overlay}
    >
      {/* Barra superior */}
      <div onClick={(e) => e.stopPropagation()} style={topBar}>
        <span style={{ color: '#fff', fontSize: 13 }}>
          {index + 1} / {items.length}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {actions?.(item)}
          <button type="button" onClick={download} title="Baixar (imagem decifrada)" style={iconBtn}>
            ⤓
          </button>
          <button
            type="button"
            onClick={() => setShowInfo((s) => !s)}
            title="Informações (i)"
            style={{ ...iconBtn, color: showInfo ? 'var(--accent)' : '#fff' }}
          >
            ⓘ
          </button>
          <button type="button" onClick={onClose} title="Fechar (Esc)" style={iconBtn}>
            ✕
          </button>
        </div>
      </div>

      {/* Navegação lateral */}
      {items.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            title="Anterior (←)"
            style={{ ...navBtn, left: 12 }}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            title="Próxima (→)"
            style={{ ...navBtn, right: 12 }}
          >
            ›
          </button>
        </>
      )}

      {/* Imagem */}
      <div onClick={(e) => e.stopPropagation()} style={stage}>
        {error ? (
          <div style={{ color: 'var(--muted)' }}>🔒 mídia indecifrável</div>
        ) : url ? (
          <img
            src={url}
            alt={item.caption ?? 'mídia'}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            style={{ maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 6 }}
          />
        ) : (
          <div style={{ color: 'var(--muted)' }}>Carregando…</div>
        )}
      </div>

      {/* Painel de informações */}
      {showInfo && (
        <div onClick={(e) => e.stopPropagation()} style={infoPanel}>
          <strong style={{ fontSize: 14 }}>ⓘ Informações</strong>
          <Row label="Enviada por" value={nameOf(item.senderId)} />
          <Row label="Data/hora" value={fmtDateTime(item.capturedAt)} />
          <Row label="Formato" value={(item.mime.split('/')[1] ?? '—').toUpperCase()} />
          <Row label="Tipo" value={item.mime} />
          <Row label="Dimensões" value={dims ? `${dims.w} × ${dims.h} px` : '—'} />
          <Row label="Tamanho" value={bytes != null ? formatBytes(bytes) : '—'} />
          {item.lat != null && item.lng != null && (
            <Row label="Localização" value={`${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`} />
          )}
          {extraInfo?.(item)}
        </div>
      )}

      {/* Legenda + player */}
      <div onClick={(e) => e.stopPropagation()} style={bottomBar}>
        {item.caption && (
          <div style={{ color: '#fff', fontSize: 13, marginBottom: 6 }}>{item.caption}</div>
        )}
        {items.length > 1 && (
          <div style={playerRow}>
            <button type="button" onClick={prev} title="Anterior" style={iconBtn}>
              ⏮
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              title={playing ? 'Pausar (espaço)' : 'Reproduzir (espaço)'}
              style={iconBtn}
            >
              {playing ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={next} title="Próxima" style={iconBtn}>
              ⏭
            </button>
            <button
              type="button"
              onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
              title="Velocidade do slideshow"
              style={{ ...iconBtn, width: 'auto', padding: '0 8px', fontSize: 12 }}
            >
              {SPEEDS[speedIdx]}s
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
      <span className="muted">{label}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.9)',
  zIndex: 1000,
  display: 'grid',
  placeItems: 'center',
};
const topBar: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 14px',
  background: 'linear-gradient(rgba(0,0,0,.6), transparent)',
};
const iconBtn: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,.25)',
  background: 'rgba(0,0,0,.4)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 16,
  display: 'grid',
  placeItems: 'center',
};
const navBtn: CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  width: 44,
  height: 64,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,.2)',
  background: 'rgba(0,0,0,.45)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 28,
  display: 'grid',
  placeItems: 'center',
  zIndex: 2,
};
const stage: CSSProperties = { display: 'grid', placeItems: 'center', padding: 16 };
const infoPanel: CSSProperties = {
  position: 'absolute',
  left: 16,
  bottom: 90,
  width: 300,
  maxWidth: '80vw',
  display: 'grid',
  gap: 6,
  padding: 14,
  borderRadius: 10,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  boxShadow: '0 8px 24px rgba(0,0,0,.5)',
};
const bottomBar: CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  padding: '10px 14px 16px',
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
};
const playerRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  background: 'rgba(0,0,0,.5)',
  border: '1px solid rgba(255,255,255,.2)',
  borderRadius: 999,
  padding: 6,
};
