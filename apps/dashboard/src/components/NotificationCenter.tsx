'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react';
import { Avatar } from './Avatar';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * Item da central de notificações (uma mensagem E2EE decifrada). O feed vem pronto
 * do console — aqui só apresentamos: avatar do remetente (na cor da trilha do agente),
 * nome em cor neutra, prévia, tempo relativo e ponto de não-lida. Agrupado por Equipe.
 */
export interface NotifItem {
  id: string;
  senderName: string;
  color: string; // cor da trilha do agente (usada no avatar; ou --accent para a Central)
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

// Sem preflight, o `border` do Tailwind fica sem estilo (ver #120) — as bordas
// separadoras deste painel vão por style inline para não depender disso.
const rowBorder = { border: 0, borderTop: '1px solid var(--border)' } as const;

export function NotificationCenter({
  items,
  onOpen,
  storageKey,
  icon: Icon = Bell,
  title = 'Notificações',
  emptyLabel = 'Nenhuma mensagem.',
}: {
  items: NotifItem[];
  onOpen: (id: string) => void;
  /** Chave de "visto até" por operação (localStorage). */
  storageKey: string;
  /** Ícone do gatilho (sino) e do estado vazio. Default: Bell. */
  icon?: LucideIcon;
  /** Rótulo do cabeçalho + tooltip/aria-label do botão. */
  title?: string;
  /** Texto do estado vazio. */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [seenTs, setSeenTs] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(0);

  // "Visto até" e "agora" só no cliente (evita mismatch de hidratação).
  useEffect(() => {
    setSeenTs(Number(localStorage.getItem(storageKey)) || 0);
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [storageKey]);

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={title}
          title={title}
          className="relative border border-solid border-border rounded-lg"
        >
          <Icon size={18} aria-hidden />
          {unread > 0 && (
            <span className="pointer-events-none absolute -top-[5px] -right-[5px] grid place-items-center">
              {/* Anel do "ping" — expande e some ATRÁS do badge. */}
              <span
                aria-hidden
                className="notif-badge-ping absolute inset-0 rounded-[9px] bg-accent"
              />
              {/* Badge sólido com o número (na frente), com fade sutil (estilo jmr26). */}
              <span className="notif-badge-pulse relative grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-accent px-1 text-[10px] font-bold text-white shadow-[0_0_0_2px_var(--bg)]">
                {unread > 9 ? '9+' : unread}
              </span>
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[340px] max-w-[92vw] overflow-hidden p-0">
        <div
          className="flex items-center justify-between px-3.5 py-2.5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <strong className="text-sm">{title}</strong>
          {unread > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="inline-flex cursor-pointer items-center gap-1.5 bg-transparent text-xs text-muted hover:text-text"
              style={{ border: 0 }}
            >
              <CheckCheck size={13} aria-hidden /> Marcar todas como lidas
            </button>
          )}
        </div>

        <ScrollArea className="max-h-[360px]">
          {items.length === 0 ? (
            <div className="px-6 py-6 text-center text-muted">
              <Icon size={26} aria-hidden className="mx-auto mb-1.5 block opacity-50" />
              <div className="text-[13px]">{emptyLabel}</div>
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
                    className="flex w-full cursor-pointer items-center justify-between bg-panel-2 px-3.5 py-1.5 text-muted"
                    style={rowBorder}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {isCollapsed ? (
                        <ChevronRight size={13} aria-hidden />
                      ) : (
                        <ChevronDown size={13} aria-hidden />
                      )}
                      <span className="text-xs font-semibold">{label}</span>
                    </span>
                    {groupUnread > 0 && (
                      <span className="rounded-[9px] bg-accent px-1.5 py-px text-[10px] font-bold text-white">
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
                          className={cn(
                            'flex w-full cursor-pointer items-start gap-2.5 px-3.5 py-2.5 text-left text-text hover:bg-panel-2',
                            isUnread && 'bg-[rgba(193,18,31,0.08)]',
                          )}
                          style={rowBorder}
                        >
                          <Avatar name={m.senderName} color={m.color} size={30} />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  'min-w-0 truncate text-[13px] text-text',
                                  isUnread ? 'font-bold' : 'font-semibold',
                                )}
                              >
                                {m.senderName}
                              </span>
                              {isUnread && (
                                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
                              )}
                              <span className="ml-auto shrink-0 text-[10px] text-muted">
                                {ago(m.capturedAt, nowMs || +new Date(m.capturedAt))}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
                              {m.isMedia && (
                                <ImageIcon size={12} aria-hidden className="shrink-0" />
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
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
