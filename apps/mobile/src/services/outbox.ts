import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PositionSample } from '../shared/contracts';

/**
 * Buffer local de resiliência de rede. Quando o agente entra numa zona de sombra
 * (túnel / sem cobertura), as posições são enfileiradas aqui e descarregadas em
 * lote assim que a conectividade é restabelecida.
 *
 * Observação: o `react-native-background-geolocation` já possui um buffer nativo
 * criptografado em SQLite. Este outbox complementa o caminho de publicação MQTT
 * da camada de aplicação. Usamos AsyncStorage: a fila NÃO é dado sensível e pode
 * crescer numa zona de sombra — o SecureStore tem limite de ~2048 bytes/chave
 * (estourado com poucas posições), que não se aplica aqui.
 */
const OUTBOX_KEY = 'cerberus_outbox';
const MAX_ITEMS = 1000;

export interface OutboxItem {
  operationId: string;
  agentId: string;
  sample: PositionSample;
}

async function readAll(): Promise<OutboxItem[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
}

async function writeAll(items: OutboxItem[]): Promise<void> {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
}

export async function queuePosition(item: OutboxItem): Promise<void> {
  const items = await readAll();
  items.push(item);
  await writeAll(items);
}

export async function outboxSize(): Promise<number> {
  return (await readAll()).length;
}

/**
 * Descarrega o buffer publicando cada item. `publish` deve retornar `true` em
 * caso de sucesso; itens que falharem permanecem na fila (ordem preservada).
 */
export async function flushOutbox(
  publish: (operationId: string, agentId: string, sample: PositionSample) => boolean,
): Promise<void> {
  const items = await readAll();
  if (items.length === 0) return;

  const remaining: OutboxItem[] = [];
  for (const item of items) {
    const ok = publish(item.operationId, item.agentId, item.sample);
    if (!ok) remaining.push(item);
  }
  await writeAll(remaining);
}
