import { RouteManeuver } from '@cerberus/shared';

/**
 * Redação das instruções de navegação em pt-BR (issue #131).
 *
 * Por que não usar `osrm-text-instructions` (a lib oficial de texto do OSRM): ela é
 * CommonJS sem tipos, e o vocabulário dela é acoplado ao OSRM — trocar o provedor de
 * rotas (que É o plano para produção) obrigaria a trocar a lib junto. Aqui a redação
 * parte do NOSSO enum `RouteManeuver`, então o adaptador do provedor é a única peça
 * que muda. São ~15 frases; a dependência não se paga.
 *
 * O texto sai pronto do servidor e viaja persistido na rota: o app do agente nunca
 * traduz nada e continua funcionando sem rede depois de baixar o trajeto.
 */

/** Preposição de ligação com o nome da via, por manobra. */
const STREET_PREPOSITION: Record<string, string> = {
  [RouteManeuver.DEPART]: 'pela',
  [RouteManeuver.STRAIGHT]: 'pela',
  [RouteManeuver.MERGE]: 'na',
  [RouteManeuver.RAMP]: 'para',
  [RouteManeuver.ROUNDABOUT]: 'para',
};

/** Frase base de cada manobra, sem o nome da via. */
const PHRASE: Record<string, string> = {
  [RouteManeuver.DEPART]: 'Siga',
  [RouteManeuver.ARRIVE]: 'Você chegou ao destino',
  [RouteManeuver.STRAIGHT]: 'Siga em frente',
  [RouteManeuver.TURN_LEFT]: 'Vire à esquerda',
  [RouteManeuver.TURN_RIGHT]: 'Vire à direita',
  [RouteManeuver.SLIGHT_LEFT]: 'Mantenha-se à esquerda',
  [RouteManeuver.SLIGHT_RIGHT]: 'Mantenha-se à direita',
  [RouteManeuver.SHARP_LEFT]: 'Vire acentuadamente à esquerda',
  [RouteManeuver.SHARP_RIGHT]: 'Vire acentuadamente à direita',
  [RouteManeuver.UTURN]: 'Faça o retorno',
  [RouteManeuver.MERGE]: 'Incorpore-se',
  [RouteManeuver.FORK_LEFT]: 'Na bifurcação, mantenha-se à esquerda',
  [RouteManeuver.FORK_RIGHT]: 'Na bifurcação, mantenha-se à direita',
  [RouteManeuver.RAMP]: 'Pegue o acesso',
  [RouteManeuver.ROUNDABOUT]: 'Na rotatória, siga',
};

/** Ordinais femininos (…ª saída) — a rotatória raramente passa da 6ª. */
const ORDINAL = ['', 'primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta'];

export interface ManeuverContext {
  maneuver: RouteManeuver;
  /** Nome da via de DESTINO da manobra (a via em que se entra), quando conhecido. */
  streetName?: string;
  /** Saída da rotatória (1-based), quando a manobra é `roundabout`. */
  roundaboutExit?: number;
}

/**
 * Monta a instrução em pt-BR de um passo. Sem nome de via, cai na frase seca
 * ("Vire à direita") — melhor do que inventar um logradouro que o agente não vê
 * na placa.
 */
export function describeManeuver(ctx: ManeuverContext): string {
  if (ctx.maneuver === RouteManeuver.ROUNDABOUT) {
    const exit = ctx.roundaboutExit;
    const ordinal = exit != null ? ORDINAL[exit] : undefined;
    const saida = ordinal
      ? `Na rotatória, pegue a ${ordinal} saída`
      : exit != null
        ? `Na rotatória, pegue a saída ${exit}`
        : 'Na rotatória, siga as placas';
    return ctx.streetName ? `${saida} para a ${ctx.streetName}` : saida;
  }

  const base = PHRASE[ctx.maneuver] ?? 'Siga em frente';
  if (ctx.maneuver === RouteManeuver.ARRIVE) return base;

  const prep = STREET_PREPOSITION[ctx.maneuver] ?? 'na';
  if (!ctx.streetName) {
    // "Siga" sozinho não diz nada; sem via vira "Siga em frente".
    return ctx.maneuver === RouteManeuver.DEPART ? 'Siga em frente' : base;
  }
  return `${base} ${prep} ${ctx.streetName}`;
}

/**
 * Distância em pt-BR para leitura/locução: metros arredondados a 10 até 1 km, depois
 * quilômetros com uma casa e vírgula decimal. Formatação manual (não `toLocaleString`)
 * para o texto ser idêntico no servidor, nos testes e no app.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '0 m';
  if (meters < 1000) {
    const rounded = meters < 20 ? Math.round(meters) : Math.round(meters / 10) * 10;
    return `${rounded} m`;
  }
  const km = meters / 1000;
  // Até 10 km uma casa decimal ajuda; acima disso o inteiro basta.
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

/**
 * Duração em pt-BR ("12 min", "1 h 20 min"). Usada no ETA exibido ao operador e ao
 * agente. Segundos são ruído numa rota veicular — o mínimo exibido é "1 min".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

/**
 * Instrução falada com a antecedência da manobra ("Em 200 m, vire à direita na X").
 * Perto da manobra (< 30 m) o "em N m" atrapalha mais do que ajuda — o agente já está
 * em cima dela.
 */
export function spokenInstruction(instruction: string, distanceMeters: number): string {
  if (distanceMeters < 30) return instruction;
  const lowered = instruction.charAt(0).toLowerCase() + instruction.slice(1);
  return `Em ${formatDistance(distanceMeters)}, ${lowered}`;
}
