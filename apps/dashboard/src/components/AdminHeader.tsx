'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearSession } from '@/lib/auth';

/** Cabeçalho do painel Admin: marca + abas + sair. `isSA` mostra a aba Auditoria. */
export function AdminHeader({ active, isSA }: { active: 'users' | 'audit'; isSA: boolean }) {
  const router = useRouter();
  const tab = (href: string, label: string, key: 'users' | 'audit') => (
    <Link
      href={href}
      className="badge"
      style={{
        color: 'var(--text)',
        background: active === key ? 'var(--panel-2)' : 'transparent',
        borderColor: active === key ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {label}
    </Link>
  );
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
        <div style={{ display: 'flex', gap: 8 }}>
          {tab('/admin/users', 'Usuários', 'users')}
          {isSA && tab('/admin/audit', 'Auditoria', 'audit')}
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
