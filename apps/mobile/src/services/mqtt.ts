import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';
import {
  agentCommandTopic,
  agentInboxTopic,
  agentPositionTopic,
  agentStatusTopic,
  operationBroadcastTopic,
  teamBroadcastTopic,
  type AgentStatus,
  type PositionSample,
} from '../shared/contracts';
import { openMessage } from '../shared/e2ee';
import { flushOutbox, queuePosition } from './outbox';

let client: MqttClient | null = null;
/** Tópico de comando DESTE agente (definido no connect) — ver AgentCommandType. */
let commandTopic: string | null = null;

/**
 * Handler dos comandos da central. Registrado de fora (pelo serviço de geolocalização)
 * para não criar import circular: geolocation já importa `publishPosition` daqui.
 */
type CommandHandler = (type: string) => void;
let commandHandler: CommandHandler | null = null;
export function setCommandHandler(h: CommandHandler | null): void {
  commandHandler = h;
}

/** Escopo da mensagem recebida (deriva do tópico/payload). */
export type MessageScope = 'central' | 'equipe' | 'dm';

/** Diretiva recebida da central, com o texto já decifrado (ou em claro se sistema). */
export interface BroadcastMessage {
  senderId: string;
  type: string;
  text: string;
  scope: MessageScope;
  teamId?: string;
  capturedAt: string;
}

/** Payload cru no canal: E2EE (`ciphertext`) ou sistema em claro (`text`). */
interface RawBroadcast {
  senderId: string;
  type: string;
  text?: string;
  ciphertext?: string;
  teamId?: string;
  recipientId?: string;
  capturedAt: string;
}

/** Identidade do agente para decifrar o envelope E2EE (id + chave secreta local). */
export interface BroadcastIdentity {
  myId: string;
  secretKey: string | null;
}

type BroadcastListener = (message: BroadcastMessage) => void;
/** Identidade E2EE do agente — a mesma para todos os tópicos assinados. */
let identity: BroadcastIdentity = { myId: '', secretKey: null };
/**
 * Registro de tópicos assinados → seus listeners. Menor privilégio (regra
 * mqtt-multitenant): o agente só recebe dos tópicos que assinou explicitamente
 * (broadcast da operação, sua(s) equipe(s) e seu inbox) — nunca wildcard.
 */
const subscriptions = new Map<string, Set<BroadcastListener>>();

/** Decifra o envelope E2EE ou repassa a mensagem de sistema em claro (alertas). */
function resolveText(m: RawBroadcast): string | null {
  if (typeof m.ciphertext === 'string' && m.ciphertext.length > 0) {
    if (!identity.secretKey) return null; // sem chave local para decifrar
    return openMessage(m.ciphertext, identity.myId, identity.secretKey);
  }
  return typeof m.text === 'string' ? m.text : null;
}

function handleIncoming(topic: string, payload: Uint8Array): void {
  // Comando de controle: payload em claro e fora do caminho de chat (que tentaria
  // decifrar um envelope E2EE que não existe aqui).
  if (topic === commandTopic) {
    try {
      const { type } = JSON.parse(Buffer.from(payload).toString()) as { type?: string };
      if (type) commandHandler?.(type);
    } catch {
      /* comando inválido — ignora */
    }
    return;
  }
  const listeners = subscriptions.get(topic);
  if (!listeners || listeners.size === 0) return; // tópico não assinado — descarta
  try {
    const m = JSON.parse(Buffer.from(payload).toString()) as RawBroadcast;
    const text = resolveText(m);
    if (text === null) return; // cifrado e não decifrável por este agente — ignora
    const scope: MessageScope = m.teamId ? 'equipe' : m.recipientId ? 'dm' : 'central';
    const message: BroadcastMessage = {
      senderId: m.senderId,
      type: m.type,
      text,
      scope,
      teamId: m.teamId,
      capturedAt: m.capturedAt,
    };
    for (const listener of listeners) listener(message);
  } catch {
    /* payload inválido — ignora */
  }
}

/** Assina um tópico específico e registra o listener. Retorna a função de desinscrição. */
function subscribeTopic(topic: string, listener: BroadcastListener): () => void {
  let set = subscriptions.get(topic);
  if (!set) {
    set = new Set();
    subscriptions.set(topic, set);
  }
  set.add(listener);
  if (client?.connected) client.subscribe(topic, { qos: 1 });
  return () => {
    const s = subscriptions.get(topic);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) {
      subscriptions.delete(topic);
      client?.unsubscribe(topic);
    }
  };
}

/** Define a identidade E2EE usada para decifrar (chamado uma vez, no boot da tela). */
export function setBroadcastIdentity(id: BroadcastIdentity): void {
  identity = id;
}

/** Assina o canal de broadcast da operação (central → agentes). Identidade já definida. */
export function subscribeBroadcast(operationId: string, listener: BroadcastListener): () => void {
  return subscribeTopic(operationBroadcastTopic(operationId), listener);
}

/** Assina o tópico de uma equipe (mensagens da equipe). Identidade já definida. */
export function subscribeTeam(
  operationId: string,
  teamId: string,
  listener: BroadcastListener,
): () => void {
  return subscribeTopic(teamBroadcastTopic(operationId, teamId), listener);
}

/** Assina o inbox do agente (DMs da central). Identidade já definida. */
export function subscribeInbox(
  operationId: string,
  agentId: string,
  listener: BroadcastListener,
): () => void {
  return subscribeTopic(agentInboxTopic(operationId, agentId), listener);
}

/**
 * Conecta ao barramento MQTT (sobre WebSockets) usando o JWT como credencial.
 * Em produção, o broker (EMQX/Mosquitto) valida o token e aplica as ACLs de
 * tópico: o agente só publica no próprio canal.
 */
export function connectMqtt(token: string, operationId: string, agentId: string): MqttClient {
  // UMA instância por processo. O guard olha a EXISTÊNCIA, não `connected`: uma
  // segunda chamada enquanto o cliente ainda está conectando/reconectando criava um
  // cliente novo e ABANDONAVA o anterior (que segue reconectando sozinho, pelo
  // `reconnectPeriod`). Com o `clientId` estável (ADR-0004) os dois órfãos brigam
  // pelo takeover do broker — um derruba o outro, ambos reconectam — virando um loop
  // infinito de conecta/desconecta. Antes o id tinha `Date.now()` e os duplicados
  // apenas coexistiam, mascarando este vazamento. `disconnectMqtt` zera `client`.
  if (client) return client;

  const statusTopic = agentStatusTopic(operationId, agentId);
  commandTopic = agentCommandTopic(operationId, agentId);
  const offline = JSON.stringify({ online: false } satisfies AgentStatus);

  client = mqtt.connect(config.mqttWsUrl, {
    // clientId ESTÁVEL (sem timestamp): numa reconexão o broker faz "takeover" da
    // sessão zumbi e publica o testamento DELA antes do CONNACK — então o `online`
    // que mandamos logo abaixo é o último a ficar retido. Com id rotativo o zumbi
    // sobreviveria até o keepalive estourar e o `offline` chegaria DEPOIS, retendo
    // um estado falso. Ver docs/decisions/adr-0004-presenca-do-agente-mqtt-lwt.md.
    clientId: `agente_${agentId}`,
    // Credencial estática do broker gerenciado (HiveMQ Cloud não faz auth JWT)
    // quando configurada; senão o JWT é a credencial (on-prem EMQX/Mosquitto).
    username: config.mqttUsername || 'jwt',
    password: config.mqttUsername ? config.mqttPassword : token,
    reconnectPeriod: 3000,
    clean: true,
    // TESTAMENTO (LWT): se o app morrer sem se despedir (rede caiu, processo morto,
    // bateria acabou), o BROKER publica isto por nós quando o keepalive expira.
    // Custo de bateria ~zero: viaja dentro do CONNECT e não gera tráfego novo — o
    // keepalive que o detecta já roda hoje para manter o barramento vivo.
    will: { topic: statusTopic, payload: offline, qos: 1, retain: true },
  });

  client.on('connect', () => {
    // Presença: `retain` faz o dashboard saber o estado assim que assina o tópico,
    // sem esperar a próxima posição (o GPS hiberna e só pinga a cada 5 min).
    client?.publish(statusTopic, JSON.stringify({ online: true } satisfies AgentStatus), {
      qos: 1,
      retain: true,
    });
    // Ao reconectar, descarrega o buffer offline (resiliência de rede).
    void flushOutbox(publishNow);
    // Canal de comando da central (fora do `subscriptions`, que é só de chat E2EE).
    if (commandTopic) client?.subscribe(commandTopic, { qos: 1 });
    // Re-assina TODOS os tópicos registrados (broadcast + equipes + inbox).
    for (const topic of subscriptions.keys()) {
      client?.subscribe(topic, { qos: 1 });
    }
  });

  // Sem este handler as falhas de conexão ficam silenciosas. Loga o motivo (host
  // inalcançável, WS recusado, etc.) — visível no Metro/debugger. O mqtt.js segue
  // tentando reconectar sozinho (reconnectPeriod).
  client.on('error', (err) => {
    console.warn(`[mqtt] falha de conexão em ${config.mqttWsUrl}:`, err?.message ?? err);
  });

  client.on('message', handleIncoming);

  return client;
}

export function isConnected(): boolean {
  return Boolean(client?.connected);
}

/** Publica imediatamente (usado pelo flush do outbox). */
function publishNow(operationId: string, agentId: string, sample: PositionSample): boolean {
  if (!client?.connected) return false;
  client.publish(agentPositionTopic(operationId, agentId), JSON.stringify(sample), { qos: 1 });
  return true;
}

/**
 * Publica uma posição. Se offline (zona de sombra), enfileira no outbox local
 * para descarga assíncrona quando a conectividade voltar.
 */
export async function publishPosition(
  operationId: string,
  agentId: string,
  sample: PositionSample,
): Promise<void> {
  if (!publishNow(operationId, agentId, sample)) {
    await queuePosition({ operationId, agentId, sample });
  }
}

/**
 * Saída LIMPA: anuncia `offline` e só então encerra. O `end(false)` espera o envio
 * (o `end(true)` de antes descartaria o publish) e o DISCONNECT limpo faz o broker
 * DESCARTAR o testamento — sem anúncio duplicado. Sem `operationId`/`agentId` não dá
 * para montar o tópico: cai no encerramento seco e o LWT resolve pelo keepalive.
 */
export function disconnectMqtt(operationId?: string, agentId?: string): void {
  const c = client;
  client = null;
  if (!c) return;
  if (c.connected && operationId && agentId) {
    c.publish(
      agentStatusTopic(operationId, agentId),
      JSON.stringify({ online: false } satisfies AgentStatus),
      { qos: 1, retain: true },
      () => c.end(false),
    );
    return;
  }
  c.end(true);
}
