'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * Tooltip (shadcn/ui · Radix) nos tokens do Cerberus — substitui o atributo `title`
 * do HTML, que o navegador desenha com atraso e estilo próprios (fundo claro, fora do
 * tema escuro) e sem controle de posição.
 *
 * Aparece ACIMA do gatilho por padrão; quando não há espaço, o Radix vira o lado
 * sozinho (`avoidCollisions`, ligado por padrão). Auto-contido: já traz o Provider,
 * então funciona em qualquer lugar — inclusive dentro de um Popover em portal.
 */
export function Tooltip({
  content,
  side = 'top',
  delayDuration = 200,
  children,
}: {
  /** Conteúdo do balão. Se vazio, o gatilho é renderizado sem tooltip. */
  content?: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
  children: React.ReactNode;
}) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              // Acima do PopoverContent (z-50) — o tooltip pode nascer dentro de um popover.
              'z-[1100] max-w-[240px] rounded-md border border-solid border-border bg-panel-2',
              'px-2 py-1 text-xs leading-snug text-text shadow-[0_4px_14px_rgba(0,0,0,0.5)]',
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-panel-2" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
