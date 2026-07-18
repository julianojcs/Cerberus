import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ROUTE_DEVIATION_METERS } from '../shared/contracts';
import { compassRose } from '../shared/geo';
import { formatDistance, formatDuration, formatEtaClock, maneuverGlyph } from '../shared/format';
import type { NavigationState } from '../services/navigation';

/**
 * Barra de navegação turn-by-turn (issue #131, Fase 5).
 *
 * Dimensionada para uso VEICULAR: a instrução é lida de relance, com o veículo em
 * movimento. Daí a fonte grande, o branco puro sobre o painel escuro (bem acima do
 * mínimo AA) e um único número dominante — a distância até a manobra. Tudo que é
 * secundário (restante, ETA) fica numa linha menor, em cinza-claro.
 */
export function NavigationBar({
  state,
  muted,
  onToggleMute,
  onCancel,
}: {
  state: NavigationState;
  muted: boolean;
  onToggleMute: () => void;
  onCancel: () => void;
}) {
  const { route } = state;

  if (!route) {
    return state.loading ? (
      <View style={styles.bar}>
        <Text style={styles.secondary}>Recebendo rota da central…</Text>
      </View>
    ) : null;
  }

  const step = state.stepIndex >= 0 ? route.steps[state.stepIndex] : undefined;
  const offRoute =
    state.offRouteMeters != null && state.offRouteMeters > ROUTE_DEVIATION_METERS
      ? state.offRouteMeters
      : null;

  return (
    <View style={[styles.bar, state.arrived && styles.barArrived]}>
      <View style={styles.headerRow}>
        <Text style={styles.destination} numberOfLines={1}>
          {route.destination.label ?? 'Destino'}
        </Text>
        <View style={styles.actions}>
          <TouchableOpacity onPress={onToggleMute} hitSlop={10} accessibilityRole="button">
            <Text style={styles.actionIcon}>{muted ? '🔇' : '🔊'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCancel} hitSlop={10} accessibilityRole="button">
            <Text style={styles.actionCancel}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {state.arrived ? (
        <View style={styles.instructionRow}>
          <Text style={styles.glyph}>⚑</Text>
          <Text style={styles.instruction}>Você chegou ao destino.</Text>
        </View>
      ) : route.fallback ? (
        // Provedor de rotas indisponível: o traçado é a linha reta. Sem manobra, sem
        // locução — só o rumo e a distância direta, e o aviso de que é traçado direto.
        <>
          <View style={styles.instructionRow}>
            <Text style={styles.glyph}>➤</Text>
            <Text style={styles.instruction}>
              {state.bearing != null
                ? `Siga rumo ${compassRose(state.bearing)}`
                : 'Aguardando posição…'}
            </Text>
          </View>
          <Text style={styles.distance}>
            {state.remainingMeters != null ? formatDistance(state.remainingMeters) : '—'}
          </Text>
          <Text style={styles.warn}>
            Traçado direto (sem cálculo por vias) — não há instruções de manobra.
          </Text>
        </>
      ) : (
        <>
          <View style={styles.instructionRow}>
            <Text style={styles.glyph}>{step ? maneuverGlyph(step.maneuver) : '↑'}</Text>
            <Text style={styles.instruction} numberOfLines={3}>
              {step?.instruction ?? 'Calculando o próximo passo…'}
            </Text>
          </View>
          <Text style={styles.distance}>
            {state.distanceToManeuverMeters != null
              ? formatDistance(state.distanceToManeuverMeters)
              : '—'}
          </Text>
          <Text style={styles.secondary}>
            {state.remainingMeters != null ? formatDistance(state.remainingMeters) : '—'} restantes
            {state.remainingSec != null
              ? ` · ${formatDuration(state.remainingSec)} · chegada ${formatEtaClock(state.remainingSec)}`
              : ''}
          </Text>
          {offRoute != null && (
            <Text style={styles.warn}>
              Fora do traçado ({formatDistance(offRoute)}) — a central recalcula a rota
              automaticamente.
            </Text>
          )}
        </>
      )}

      {route.recalculatedFrom != null && !state.arrived && (
        <Text style={styles.badge}>ROTA RECALCULADA</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#1c2733',
    borderRadius: 12,
    borderLeftWidth: 5,
    borderLeftColor: '#2f81f7',
    padding: 16,
    marginTop: 12,
  },
  barArrived: { borderLeftColor: '#3fb950' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  destination: { color: '#8b9aa8', fontSize: 13, flex: 1, marginRight: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  actionIcon: { fontSize: 20 },
  // Cor explícita: texto de controle nunca herda a cor de sistema (ver ui-contrast).
  actionCancel: { color: '#c1121f', fontSize: 20, fontWeight: '800' },
  instructionRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 12 },
  glyph: { color: '#fff', fontSize: 40, lineHeight: 44, fontWeight: '700' },
  instruction: { color: '#fff', fontSize: 22, fontWeight: '700', flex: 1, lineHeight: 28 },
  distance: { color: '#fff', fontSize: 34, fontWeight: '800', marginTop: 6, letterSpacing: 0.5 },
  secondary: { color: '#c8d3de', fontSize: 15, marginTop: 4 },
  warn: { color: '#e3b341', fontSize: 14, marginTop: 8, lineHeight: 19 },
  badge: {
    color: '#e3b341',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 10,
  },
});
