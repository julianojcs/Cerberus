'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearSession } from '@/lib/auth';

export type AdminTab = 'users' | 'operations' | 'map' | 'broadcast' | 'devices' | 'audit';

/** Uma aba do painel: rótulo, rota e se exige SuperAdmin. */
const TABS: { key: AdminTab; href: string; label: string; saOnly: boolean }[] = [
  { key: 'users', href: '/admin/users', label: 'Usuários', saOnly: false },
  { key: 'operations', href: '/admin/operations', label: 'Operações', saOnly: false },
  { key: 'map', href: '/admin/map', label: 'Mapa global', saOnly: true },
  { key: 'broadcast', href: '/admin/broadcast', label: 'Broadcast', saOnly: true },
  { key: 'devices', href: '/admin/devices', label: 'Dispositivos', saOnly: true },
  { key: 'audit', href: '/admin/audit', label: 'Auditoria', saOnly: true },
];

/** Cabeçalho do painel Admin: marca + abas + sair. `isSA` revela as abas globais. */
export function AdminHeader({ active, isSA }: { active: AdminTab; isSA: boolean }) {
  const router = useRouter();
  return (
    <div className="topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Link href="/operations" className="badge" style={{ color: 'var(--text)' }}>
          ← Operações
        </Link>
        <div className="brand">
          <span className="brand-dot" />
          Painel Admin
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TABS.filter((t) => isSA || !t.saOnly).map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className="badge"
              style={{
                color: 'var(--text)',
                background: active === t.key ? 'var(--panel-2)' : 'transparent',
                borderColor: active === t.key ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>
      <button
        className="btn"
        style={{ background: 'var(--panel-2)' }}
        onClick={() => {
          clearSession();
          router.replace('/login');
        }}
      >
        Sair
      </button>
    </div>
  );
}
