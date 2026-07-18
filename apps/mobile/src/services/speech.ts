/**
 * Locução das instruções de navegação (pt-BR).
 *
 * Envoltório FINO e tolerante em volta do `expo-speech`: o módulo é nativo e pode
 * simplesmente não existir no binário instalado no aparelho (build antigo do
 * dev-client, prebuild não refeito, TTS ausente no Android do fabricante). Navegar é
 * a função crítica; falar é conforto. Por isso o módulo é resolvido por `require`
 * dentro de try/catch e vira NO-OP silencioso quando falta — um import estático
 * derrubaria o bundle inteiro por causa da voz.
 */

/** Subconjunto da API do expo-speech que usamos (evita depender dos tipos do pacote). */
interface SpeechModule {
  speak(text: string, options?: { language?: string; rate?: number; pitch?: number }): void;
  stop(): void;
}

function isSpeechModule(value: unknown): value is SpeechModule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SpeechModule>;
  return typeof candidate.speak === 'function' && typeof candidate.stop === 'function';
}

// `undefined` = ainda não tentamos carregar; `null` = tentamos e não há módulo.
let cached: SpeechModule | null | undefined;

function speech(): SpeechModule | null {
  if (cached !== undefined) return cached;
  try {
    const loaded: unknown = require('expo-speech');
    cached = isSpeechModule(loaded) ? loaded : null;
  } catch {
    cached = null;
  }
  if (!cached) console.warn('[speech] expo-speech indisponível — navegação seguirá muda.');
  return cached;
}

let muted = false;

export function isMuted(): boolean {
  return muted;
}

/** Muta/desmuta a locução. Ao mutar, corta a fala em curso (não espera terminar). */
export function setMuted(value: boolean): void {
  muted = value;
  if (value) stopSpeaking();
}

/** Fala o texto em pt-BR. Silencioso e sem lançar se o TTS não estiver disponível. */
export function speak(text: string): void {
  if (muted || !text) return;
  try {
    // `rate` levemente abaixo do padrão: instrução de trânsito precisa ser entendida
    // de primeira, dentro de um veículo em movimento.
    speech()?.speak(text, { language: 'pt-BR', rate: 0.95, pitch: 1 });
  } catch {
    /* TTS falhou neste aparelho — a instrução segue visível na barra */
  }
}

export function stopSpeaking(): void {
  try {
    speech()?.stop();
  } catch {
    /* nada a interromper */
  }
}
