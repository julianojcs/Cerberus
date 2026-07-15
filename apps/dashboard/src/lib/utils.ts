import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Junta classes condicionais (clsx) e resolve conflitos de utilities do Tailwind
 * (tailwind-merge). Base dos componentes shadcn/ui — issue #117.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
