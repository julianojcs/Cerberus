import { describe, expect, it } from 'vitest';
import { formatDistance, formatDuration, spokenInstruction } from './instructions.js';
import * as mobile from '../../../../mobile/src/shared/format.js';

/**
 * Paridade de formatação entre o SERVIDOR e o APP (issue #131).
 *
 * A formatação existe duplicada de propósito: o app móvel fica fora dos workspaces npm
 * (restrição do Metro bundler), então ele espelha estas funções em
 * `apps/mobile/src/shared/format.ts` — mesmo motivo pelo qual `contracts.ts` espelha os
 * tópicos e schemas.
 *
 * Duplicação sem trava vira divergência silenciosa: a barra de navegação mostraria
 * "1,2 km" e a locução falaria "1.2 km" para a MESMA rota, e ninguém percebe até estar
 * em campo. Este teste é a trava. Por isso um teste da API importa código do mobile —
 * é feio de propósito e a alternativa é não ter proteção nenhuma.
 *
 * Se o Metro/tsconfig do mobile mudar e este import quebrar, NÃO remova o teste: ou
 * conserte o caminho, ou promova a formatação a um pacote compartilhado de verdade.
 */

/** Fronteiras da lógica: limiar de arredondamento (20), de km (1000) e de casa decimal (10 km). */
const DISTANCES = [0, 5, 12, 19, 20, 21, 99, 187, 500, 999, 1000, 1234, 5678, 9999, 10_000, 15_400, 99_999, -1];
/** Fronteiras: piso de 1 min, virada da hora e hora cheia. */
const DURATIONS = [0, 1, 29, 30, 60, 90, 720, 3599, 3600, 4800, 7200, 86_400, -5];
/** Fronteira dos 30 m, em que a locução para de antecipar a manobra. */
const SPOKEN_DISTANCES = [0, 10, 29, 30, 200, 1500];

describe('formatação: servidor x app', () => {
  it('formatDistance é idêntico', () => {
    for (const m of DISTANCES) {
      // Prefixa a entrada para a falha apontar QUAL valor divergiu.
      expect(`${m} → ${mobile.formatDistance(m)}`).toBe(`${m} → ${formatDistance(m)}`);
    }
  });

  it('formatDuration é idêntico', () => {
    for (const s of DURATIONS) {
      expect(`${s} → ${mobile.formatDuration(s)}`).toBe(`${s} → ${formatDuration(s)}`);
    }
  });

  it('spokenInstruction é idêntico', () => {
    const instruction = 'Vire à direita na Rua Gonçalves Dias';
    for (const m of SPOKEN_DISTANCES) {
      expect(`${m} → ${mobile.spokenInstruction(instruction, m)}`).toBe(
        `${m} → ${spokenInstruction(instruction, m)}`,
      );
    }
  });
});
