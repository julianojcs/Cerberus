import { RouteManeuver } from './contracts';

/**
 * Formatação de texto exibido ao agente.
 *
 * `formatDistance`/`formatDuration`/`spokenInstruction` são o espelho local de
 * `apps/api/src/modules/navigation/instructions.ts` — mesmo motivo do espelho em
 * `contracts.ts`: o app fica fora dos workspaces npm e não resolve `@cerberus/shared`
 * pelo Metro. A saída PRECISA ser idêntica à do servidor: a instrução do passo chega
 * pronta ("Vire à direita na Rua X") e o app só acrescenta a antecedência
 * ("Em 200 m, ..."). Se as duas redações divergirem, a mesma rota fala uma coisa e
 * mostra outra. Mantenha em sincronia com o arquivo do servidor.
 */

/** Metros arredondados a 10 até 1 km, depois quilômetros com vírgula decimal. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';
  if (meters < 1000) {
    const rounded = meters < 20 ? Math.round(meters) : Math.round(meters / 10) * 10;
    return `${rounded} m`;
  }
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

/** Duração em pt-BR ("12 min", "1 h 20 min"). Segundos são ruído numa rota veicular. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

/**
 * Acrescenta a antecedência da manobra à instrução ("Em 200 m, vire à direita na X").
 * Colado na manobra (< 30 m) o "em N m" atrapalha — o agente já está em cima dela.
 */
export function spokenInstruction(instruction: string, distanceMeters: number): string {
  if (distanceMeters < 30) return instruction;
  const lowered = instruction.charAt(0).toLowerCase() + instruction.slice(1);
  return `Em ${formatDistance(distanceMeters)}, ${lowered}`;
}

/**
 * Instante UTC exibido no fuso do operador. A telemetria continua em UTC ponta a
 * ponta — isto é camada de apresentação (ver .claude/rules/timezone-dates.md).
 */
export function formatClock(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));
  } catch {
    // Fallback caso o build do Hermes não traga ICU/fuso: hora local do aparelho.
    return new Date(iso).toTimeString().slice(0, 8);
  }
}

/** Hora prevista de chegada (relógio local), a partir dos segundos que faltam. */
export function formatEtaClock(remainingSec: number): string {
  return formatClock(new Date(Date.now() + remainingSec * 1000).toISOString()).slice(0, 5);
}

/**
 * Símbolo da manobra para a barra de navegação. Glifos Unicode em vez de um pacote de
 * ícones: a barra é lida de relance ao volante e o app não carrega fonte de ícones.
 */
const MANEUVER_GLYPH: Record<RouteManeuver, string> = {
  [RouteManeuver.DEPART]: '➤',
  [RouteManeuver.ARRIVE]: '⚑',
  [RouteManeuver.STRAIGHT]: '↑',
  [RouteManeuver.TURN_LEFT]: '↰',
  [RouteManeuver.TURN_RIGHT]: '↱',
  [RouteManeuver.SLIGHT_LEFT]: '↖',
  [RouteManeuver.SLIGHT_RIGHT]: '↗',
  [RouteManeuver.SHARP_LEFT]: '↰',
  [RouteManeuver.SHARP_RIGHT]: '↱',
  [RouteManeuver.UTURN]: '⤺',
  [RouteManeuver.ROUNDABOUT]: '⟳',
  [RouteManeuver.MERGE]: '⤳',
  [RouteManeuver.FORK_LEFT]: '↖',
  [RouteManeuver.FORK_RIGHT]: '↗',
  [RouteManeuver.RAMP]: '⤴',
};

export function maneuverGlyph(maneuver: RouteManeuver): string {
  return MANEUVER_GLYPH[maneuver] ?? '↑';
}
