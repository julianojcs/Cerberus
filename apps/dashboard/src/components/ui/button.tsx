'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Botão base (shadcn/ui, estilo new-york) adaptado aos tokens do Cerberus.
 * Nota: o dashboard NÃO usa o preflight do Tailwind (ver #120), então bordas
 * levam sempre `border-solid` explícito — sem ele, `border` fica com estilo
 * `none` e a linha não aparece.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:opacity-90',
        outline: 'border border-solid border-border bg-transparent text-text hover:bg-panel-2',
        ghost: 'bg-transparent text-text hover:bg-panel-2',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        icon: 'h-[34px] w-[34px] p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
