'use client';

import { Toaster as Sonner, toast } from 'sonner';

/**
 * Toasts de retorno das AÇÕES do operador (shadcn/ui · sonner), nos tokens do Cerberus.
 *
 * Por que existe: até aqui uma ação ou não dizia nada (o clique parecia inerte) ou só
 * reclamava no `console`, que operador nenhum abre. Toda ação que sai do navegador —
 * emitir comando, salvar zona, recalcular alertas — deve confirmar ou explicar a falha.
 *
 * Posição: canto SUPERIOR direito. O inferior direito já é do menu de efeitos do mapa.
 *
 * Uso: `import { toast } from '@/components/ui/sonner'` e
 * `toast.success('Título', { description: '…' })` / `toast.error(...)`.
 */
export function Toaster() {
  return (
    <Sonner
      position="top-right"
      closeButton
      // `richColors` deixa o sonner pintar success/error; o resto vem dos nossos tokens.
      richColors
      toastOptions={{
        style: {
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
        },
        classNames: { description: 'text-muted' },
      }}
    />
  );
}

export { toast };
