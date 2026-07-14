'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getToken, getUser } from '@/lib/auth';
import { keyState, type KeyState } from '@/lib/e2ee';
import { UnlockKeyModal } from './UnlockKeyModal';

/**
 * Portão de desbloqueio da chave E2EE (Fase 5e-1). Fica no layout raiz: em qualquer
 * página autenticada, se a chave não estiver DESBLOQUEADA nesta sessão (chave em
 * memória), abre o `UnlockKeyModal` — criando/migrando/desbloqueando conforme o
 * estado. Some no `/login` e quando não há sessão.
 */
export function E2eeUnlockGate() {
  const pathname = usePathname();
  const [state, setState] = useState<KeyState>('unlocked'); // otimista: evita flash na hidratação
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const user = getUser();
    if (!user || !getToken()) {
      setUserId(null);
      setState('unlocked');
      return;
    }
    setUserId(user.id);
    setState(keyState(user.id));
  }, [pathname]); // reavalia a cada navegação (o layout raiz não remonta)

  if (!userId || state === 'unlocked' || pathname === '/login') return null;
  return <UnlockKeyModal userId={userId} mode={state} onDone={() => setState('unlocked')} />;
}
