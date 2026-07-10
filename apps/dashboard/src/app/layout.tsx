import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cerberus — Administração Central',
  description: 'Console de comando e controle para monitoramento posicional tático.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
