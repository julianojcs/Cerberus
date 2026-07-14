import type { Metadata } from 'next';
import 'animate.css/animate.min.css';
import './globals.css';
import { E2eeUnlockGate } from '@/components/E2eeUnlockGate';

export const metadata: Metadata = {
  title: 'Cerberus — Administração Central',
  description: 'Console de comando e controle para monitoramento posicional tático.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        {/* Fase 5e-1 — desbloqueio da chave E2EE em repouso (overlay quando travada). */}
        <E2eeUnlockGate />
      </body>
    </html>
  );
}
