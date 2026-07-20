import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { searchAddresses } from '../services/navigation';
import type { LatLng } from '../shared/geo';
import type { GeocodeResponse, GeocodeResult } from '../shared/contracts';

/**
 * Busca de destino por endereço (issue #131).
 *
 * Layout no padrão dos apps de navegação do mercado: campo com lupa, resultados em
 * lista de DUAS linhas (via em destaque, bairro · cidade em tom secundário) e toque no
 * item para confirmar. A confirmação em si NÃO mora aqui — sai pelo `onSelect` e cai no
 * mesmo diálogo do toque no mapa, para que os dois caminhos de entrada terminem no
 * mesmo lugar.
 *
 * **Sem autocomplete por digitação, de propósito.** A política de uso do Nominatim
 * proíbe busca a cada tecla; o servidor ainda serializa tudo num teto de 1 req/s para o
 * processo inteiro, então um debounce local só encheria a fila. A busca dispara no
 * submit — botão ou tecla de busca do teclado. Não trocar `onSubmitEditing` por
 * `onChangeText` + debounce.
 */

/** Estado da última busca submetida. `idle` = ainda não buscou nada nesta sessão. */
type SearchPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; response: GeocodeResponse }
  | { kind: 'error'; message: string };

/** O `kind` do provedor só serve para escolher o ícone — a lista já vem ordenada. */
function resultGlyph(kind?: string): string {
  if (kind === 'house' || kind === 'building' || kind === 'residential') return '🏠';
  if (kind === 'road' || kind === 'street' || kind === 'residential_road') return '🛣️';
  if (kind === 'suburb' || kind === 'neighbourhood' || kind === 'city' || kind === 'town') {
    return '🏙️';
  }
  return '📍';
}

export function DestinationSearch({
  near,
  onSelect,
  disabled = false,
}: {
  /**
   * Posição atual do agente — enviesa o resultado para perto dele. Sem isso "Rua
   * Bahia" devolve acertos no país inteiro.
   */
  near: LatLng | null;
  onSelect: (result: GeocodeResult) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<SearchPhase>({ kind: 'idle' });

  async function handleSubmit() {
    const text = query.trim();
    if (!text || phase.kind === 'loading' || disabled) return;
    setPhase({ kind: 'loading' });
    try {
      setPhase({ kind: 'done', response: await searchAddresses(text, near) });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Não foi possível buscar o endereço.',
      });
    }
  }

  function handleClear() {
    setQuery('');
    setPhase({ kind: 'idle' });
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.field}>
        <Text style={styles.fieldIcon}>🔍</Text>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar endereço ou local…"
          placeholderTextColor="#8b9aa8"
          // A busca é submetida, nunca disparada por digitação (ver o cabeçalho).
          returnKeyType="search"
          onSubmitEditing={() => void handleSubmit()}
          autoCorrect={false}
          editable={!disabled}
        />
        {query.length > 0 && (
          <TouchableOpacity
            onPress={handleClear}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Limpar busca"
          >
            <Text style={styles.clear}>✕</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.submit, (disabled || !query.trim()) && styles.submitDisabled]}
          onPress={() => void handleSubmit()}
          disabled={disabled || !query.trim() || phase.kind === 'loading'}
          accessibilityRole="button"
        >
          <Text style={styles.submitText}>Buscar</Text>
        </TouchableOpacity>
      </View>

      {phase.kind === 'loading' && (
        <View style={styles.stateRow}>
          <ActivityIndicator color="#2f81f7" size="small" />
          <Text style={styles.loadingText}>Procurando endereços…</Text>
        </View>
      )}

      {phase.kind === 'error' && <Text style={styles.errorText}>{phase.message}</Text>}

      {phase.kind === 'done' && phase.response.results.length === 0 && (
        <Text style={styles.stateText}>
          Nenhum resultado encontrado. Tente incluir o número, o bairro ou a cidade.
        </Text>
      )}

      {/* Número digitado, mas nenhum acerto o trouxe: o OpenStreetMap não tem esse
          número mapeado na via. Não dá para inventá-lo — mas calar faria o agente
          concluir que o app descartou o que ele digitou. */}
      {phase.kind === 'done' &&
        !!phase.response.houseNumber &&
        !phase.response.houseNumberMatched &&
        phase.response.results.length > 0 && (
          <Text style={styles.warningText}>
            O número {phase.response.houseNumber} não está mapeado nesta via. Escolha o
            trecho abaixo e ajuste o ponto exato tocando no mapa.
          </Text>
        )}

      {/* Lista simples (o servidor devolve no máximo 6 acertos já sem repetições): uma
          FlatList aqui viraria lista virtualizada dentro do ScrollView da tela, que o
          React Native adverte e mede errado. */}
      {phase.kind === 'done' &&
        phase.response.results.map((result) => (
          <TouchableOpacity
            key={`${result.lat},${result.lng},${result.label}`}
            style={styles.item}
            onPress={() => onSelect(result)}
            disabled={disabled}
            accessibilityRole="button"
          >
            <Text style={styles.itemGlyph}>{resultGlyph(result.kind)}</Text>
            <View style={styles.itemText}>
              <Text style={styles.itemTitle} numberOfLines={1}>
                {result.title}
              </Text>
              {result.subtitle.length > 0 && (
                <Text style={styles.itemSubtitle} numberOfLines={1}>
                  {result.subtitle}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        ))}

      {phase.kind === 'idle' && (
        <Text style={styles.hint}>
          {near
            ? 'Busque pelo endereço; os resultados priorizam o que está perto de você.'
            : 'Sem posição conhecida ainda — a busca cobre todo o país até o GPS pegar o primeiro fix.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0b0f14',
    borderColor: '#263543',
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
  },
  fieldIcon: { fontSize: 15 },
  input: {
    flex: 1,
    color: '#e6edf3',
    fontSize: 15,
    paddingVertical: 8,
  },
  // Cores explícitas em TODO controle: sem elas o texto herda a cor de sistema e
  // desaparece no painel escuro (ver .claude/rules/ui-contrast.md).
  clear: { color: '#8b9aa8', fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  submit: {
    backgroundColor: '#2f81f7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  stateText: { color: '#8b9aa8', fontSize: 13, marginTop: 12, lineHeight: 18 },
  loadingText: { color: '#8b9aa8', fontSize: 13, lineHeight: 18 },
  errorText: { color: '#e3b341', fontSize: 13, marginTop: 12, lineHeight: 18 },
  // Âmbar: é aviso, não falha — a busca funcionou, o dado é que não existe no mapa.
  warningText: { color: '#d29922', fontSize: 13, marginTop: 12, lineHeight: 18 },
  hint: { color: '#8b9aa8', fontSize: 12, marginTop: 10, lineHeight: 17 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomColor: '#263543',
    borderBottomWidth: 1,
  },
  itemGlyph: { fontSize: 18 },
  itemText: { flex: 1 },
  itemTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '600' },
  itemSubtitle: { color: '#8b9aa8', fontSize: 13, marginTop: 2 },
});
