'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, LayoutGrid, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { clearSession, getUser } from '@/lib/auth';
import { lockAll } from '@/lib/e2ee';
import { Avatar } from './Avatar';

const roleLabel: Record<string, string> = {
  superadmin: 'SuperAdmin',
  admin: 'Central de Comando',
  agente: 'Agente de Campo',
};

/**
 * Menu do usuário logado (avatar + nome → dropdown). Mostra a identidade e as ações:
 * ir para Operações, abrir Configurações e Sair (limpa sessão + trava as chaves E2EE).
 */
export function UserMenu({ onSettings }: { onSettings?: () => void }) {
  const router = useRouter();
  const user = getUser();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (!user) return null;

  function logout() {
    clearSession();
    lockAll();
    router.replace('/login');
  }

  const item: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    padding: '9px 14px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text)',
    fontSize: 13,
    cursor: 'pointer',
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="Menu do usuário"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 8px 3px 3px',
          borderRadius: 20,
          border: '1px solid var(--border)',
          background: open ? 'var(--panel-2)' : 'transparent',
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <Avatar name={user.name} size={28} />
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{user.name}</span>
        <ChevronDown size={15} aria-hidden style={{ opacity: 0.7 }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            width: 240,
            maxWidth: '92vw',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{user.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>@{user.username}</div>
            <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>
              {roleLabel[user.role] ?? user.role}
            </div>
          </div>

          <button
            type="button"
            style={item}
            onClick={() => {
              setOpen(false);
              router.push('/operations');
            }}
          >
            <LayoutGrid size={16} aria-hidden /> Operações
          </button>
          {onSettings && (
            <button
              type="button"
              style={item}
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <SettingsIcon size={16} aria-hidden /> Configurações
            </button>
          )}
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              style={{ ...item, color: 'var(--accent)' }}
              onClick={() => {
                setOpen(false);
                logout();
              }}
            >
              <LogOut size={16} aria-hidden /> Sair
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
