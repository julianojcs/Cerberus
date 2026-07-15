'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CheckCheck, ChevronDown, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { Avatar } from './Avatar';

/**
 * Item da central de notificações (uma mensagem E2EE decifrada). O feed vem pronto
 * do console — aqui só apresentamos: avatar do remetente, título na cor da trilha do
 * agente, prévia, tempo relativo e ponto de não-lida. Agrupado por Equipe.
 */
export interface NotifItem {
  id: string;
  senderName: string;
  color: string; // cor da trilha do agente (ou --accent para a Central)
  isMedia: boolean;
  preview: string;
  capturedAt: string; // ISO
  group: string; // "Equipe Alfa" | "Direto"
}

/** Tempo relativo curto em pt-BR (sem lib): "agora", "há 5 min", "há 2 h", "há 3 d". */
function ago(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - +new Date(iso));
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} d`;
}

export function NotificationCenter({
  items,
  onOpen,
  storageKey,
}: {
  items: NotifItem[];
  onOpen: (id: string) => void;
  /** Chave de "visto até" por operação (localStorage). */
  storageKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [seenTs, setSeenTs] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // "Visto até" e "agora" só no cliente (evita mismatch de hidratação).
  useEffect(() => {
    setSeenTs(Number(localStorage.getItem(storageKey)) || 0);
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [storageKey]);

  // Fecha ao clicar fora / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = useMemo(
    () => items.filter((m) => +new Date(m.capturedAt) > seenTs).length,
    [items, seenTs],
  );

  function markAllRead() {
    const latest = items.reduce((mx, m) => Math.max(mx, +new Date(m.capturedAt)), Date.now());
    setSeenTs(latest);
    try {
      localStorage.setItem(storageKey, String(latest));
    } catch {
      /* ignora */
    }
  }

  // Agrupa por "group" preservando a ordem (itens já vêm mais recentes primeiro).
  const groups = useMemo(() => {
    const map = new Map<string, NotifItem[]>();
    for (const m of items) (map.get(m.group) ?? map.set(m.group, []).get(m.group)!).push(m);
    return [...map.entries()];
  }, [items]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="Notificações"
        aria-expanded={open}
        title="Mensagens (E2EE)"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
          width: 34,
          height: 34,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: open ? 'var(--panel-2)' : 'transparent',
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <Bell size={18} aria-hidden />
        {unread > 0 && (
          <span
            className="notif-badge-pulse"
            style={{
              position: 'absolute',
              top: -5,
              right: -5,
              minWidth: 18,
              height: 18,
              padding: '0 4px',
              borderRadius: 9,
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 42,
            right: 0,
            width: 340,
            maxWidth: '92vw',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <strong style={{ fontSize: 14 }}>Notificações</strong>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <CheckCheck size={13} aria-hidden /> Marcar todas como lidas
              </button>
            )}
          </div>

          <div className="thinscroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                <Bell size={26} aria-hidden style={{ opacity: 0.5, marginBottom: 6 }} />
                <div style={{ fontSize: 13 }}>Nenhuma mensagem.</div>
              </div>
            ) : (
              groups.map(([label, msgs]) => {
                const isCollapsed = collapsed[label] ?? false;
                const groupUnread = msgs.filter((m) => +new Date(m.capturedAt) > seenTs).length;
                return (
                  <div key={label}>
                    <button
                      type="button"
                      onClick={() => setCollapsed((p) => ({ ...p, [label]: !isCollapsed }))}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        padding: '6px 14px',
                        background: 'var(--panel-2)',
                        border: 'none',
                        borderTop: '1px solid var(--border)',
                        color: 'var(--muted)',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {isCollapsed ? (
                          <ChevronRight size={13} aria-hidden />
                        ) : (
                          <ChevronDown size={13} aria-hidden />
                        )}
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
                      </span>
                      {groupUnread > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            background: 'var(--accent)',
                            color: '#fff',
                            borderRadius: 9,
                            padding: '1px 6px',
                          }}
                        >
                          {groupUnread}
                        </span>
                      )}
                    </button>
                    {!isCollapsed &&
                      msgs.map((m) => {
                        const isUnread = +new Date(m.capturedAt) > seenTs;
                        return (
                          <button
                            type="button"
                            key={m.id}
                            onClick={() => {
                              onOpen(m.id);
                              setOpen(false);
                            }}
                            title="Abrir no Chat"
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              width: '100%',
                              textAlign: 'left',
                              padding: '9px 14px',
                              background: isUnread ? 'rgba(193,18,31,0.08)' : 'transparent',
                              border: 'none',
                              borderTop: '1px solid var(--border)',
                              color: 'var(--text)',
                              cursor: 'pointer',
                            }}
                          >
                            <Avatar name={m.senderName} color={m.color} size={30} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  minWidth: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: isUnread ? 700 : 600,
                                    color: m.color,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {m.senderName}
                                </span>
                                {isUnread && (
                                  <span
                                    style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: '50%',
                                      background: 'var(--accent)',
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <span
                                  className="muted"
                                  style={{ marginLeft: 'auto', fontSize: 10, flexShrink: 0 }}
                                >
                                  {ago(m.capturedAt, nowMs || +new Date(m.capturedAt))}
                                </span>
                              </div>
                              <div
                                className="muted"
                                style={{
                                  fontSize: 12,
                                  marginTop: 2,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {m.isMedia && (
                                  <ImageIcon size={12} aria-hidden style={{ flexShrink: 0 }} />
                                )}
                                {m.preview}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
