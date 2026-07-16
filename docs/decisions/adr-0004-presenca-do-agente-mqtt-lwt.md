# ADR-0004 — Presença do agente via canal `status` + LWT do MQTT

- **Status:** Aceito
- **Data:** 2026-07-16
- **Contexto relacionado:** [ADR-0001 — ACL multitenant faseada](adr-0001-acl-multitenant-faseada.md) ·
  [regra mqtt-multitenant](../../.claude/rules/mqtt-multitenant.md)

## Contexto

O dashboard precisa dizer se um agente está **conectado e transmitindo**. Até aqui isso
era **inferido** do frescor da última posição (“recebi telemetria há pouco ⇒ está vivo”).

Esse proxy tem uma falha de fundo: ele mede a **taxa do GPS**, não o **estado do
transporte**. E a taxa do GPS varia de propósito, por bateria
(`apps/mobile/src/services/geolocation.ts`):

```
stopTimeout: 5,          // minutos parado antes de hibernar o GPS
heartbeatInterval: 300,  // 5 min de ping quando estático
distanceFilter: 10,      // metros entre amostras em deslocamento
```

Ou seja, um agente **parado e perfeitamente saudável** só pinga **a cada 5 minutos**. Com
o limiar de frescor em 60 s, ele aparecia como desconectado quase sempre — foi
exatamente o bug observado com o `AG-0456`, que estava com barramento conectado, GPS
ligado e compartilhamento ativo, e ainda assim era desenhado como “sem sinal”.

Pior: o proxy **não consegue distinguir** duas situações opostas —

| Situação | Frescor de posição | Realidade |
| --- | --- | --- |
| GPS hibernando (app saudável, parado) | “sumido” ❌ | **online** |
| App morto / sem rede | “sumido” | **offline** |

Aumentar o limiar (fizemos: `2 × heartbeat + folga = 11 min`) **elimina o
falso-negativo**, mas ao custo de até 11 minutos de latência para acusar uma queda real
— e continua sem separar as duas situações acima.

## Decisão

Adotar um **sinal de presença explícito** no canal `status` que já existia na taxonomia
(`operacao/{opId}/agente/{agentId}/status`), usando o **LWT (Last Will and Testament)**
do MQTT.

### Contrato

Payload (`agentStatusSchema` em `packages/shared/src/schemas.ts`):

```jsonc
{ "online": true }   // ou false
```

Sem `agentId` no corpo **de propósito**: a identidade vem do **tópico**, nunca do payload
(regra Zero Trust). O payload do LWT é fixado no CONNECT, então também não carrega
timestamp — o instante relevante é o da recepção.

### Mecânica

1. **Ao conectar**, o agente registra o **testamento** junto ao broker
   (`will: { topic: status, payload: {online:false}, qos: 1, retain: true }`) e publica
   `{online:true}` **retido**.
2. **Se o app morrer sem se despedir** (rede caiu, processo morto, bateria acabou), o
   **broker** publica o testamento sozinho quando o keepalive expira (~90 s com o
   keepalive padrão de 60 s do mqtt.js).
3. **Na saída limpa** (logout), o agente publica `{online:false}` e desconecta; o
   DISCONNECT limpo faz o broker **descartar** o testamento (sem anúncio duplicado).
4. **`retain: true`** faz o dashboard conhecer o estado **no instante em que assina** o
   tópico, sem esperar a próxima posição.

### `clientId` estável

O `clientId` passou de `agente_${id}_${Date.now()}` para **`agente_${id}`**. Numa
reconexão, o broker faz **takeover** da sessão zumbi e publica o testamento **dela**
antes do CONNACK — então o `{online:true}` que o cliente novo manda em seguida é o
último a ficar retido. Com o id rotativo, o zumbi sobreviveria até o keepalive estourar
e o `{online:false}` chegaria **depois** do `{online:true}`, retendo um estado falso.

### Consumo no dashboard

`subscribeToOperation` ganhou `onPresence(agentId, online)`. O dashboard já assinava
`operacao/{opId}/#` — as mensagens de status **já chegavam** e eram descartadas.

O mapa usa: **presença explícita manda; sem ela, cai no proxy de frescor**
(`presence[agentId] ?? isFresh(point, now)`). Isso mantém compatibilidade com apps
antigos que ainda não publicam status.

## Custo de bateria: ~zero

Este foi o critério decisivo. **A conexão já existe e já é mantida**: o app abre um
WebSocket MQTT persistente e o mqtt.js já manda `PINGREQ` a cada ~60 s (keepalive
padrão) para segurá-lo — é isso que acende o “Barramento: conectado”. Esse custo de
rádio **já é pago hoje**.

Somando o LWT em cima:

- **Registrar o testamento** = alguns bytes a mais **dentro do pacote CONNECT** que já é
  enviado, uma vez por conexão. **Zero mensagens extras.**
- **Quando o agente cai**, quem publica é o **broker** — o aparelho está morto/sem rede e
  não gasta nada.
- Tráfego novo do aparelho: **1 publish minúsculo ao conectar** (+1 no logout).
  Irrelevante perto do fluxo de posições.

O único botão que custaria bateria seria **encurtar o keepalive** para detectar quedas
mais rápido — e não precisamos: os 60 s que já rodam dão detecção em ~90 s, contra os
11 min do proxy. **~7× mais rápido, de graça.**

## Consequências

**Positivas**
- Separa **estado do transporte** (socket vivo?) de **taxa do GPS** (frequência de ping)
  — acaba com o falso-negativo da hibernação.
- Detecção de queda em ~90 s em vez de 11 min.
- Dashboard sabe o estado **ao abrir** (retido), sem esperar telemetria.
- Sem custo de bateria relevante e sem novo componente de infra.

**Negativas / riscos**
- **Doze/background do Android:** se o SO suspender o socket com o app em segundo plano,
  o keepalive estoura e o LWT dispara um “offline” falso. O app roda com notificação
  fixa (foreground service), o que normalmente segura a conexão — **precisa validação em
  campo**.
- **Confiança no broker:** a presença passa a depender do broker publicar o testamento
  corretamente (comportamento padrão do MQTT 3.1.1/5; HiveMQ Cloud atende).
- O proxy de frescor **continua no código** como fallback — dois caminhos para a mesma
  pergunta, o que exige disciplina para não divergirem.

## Alternativas consideradas

- **Só aumentar o limiar de frescor** (feito antes desta ADR): resolve o falso-negativo,
  mas mantém 11 min de latência e não separa hibernação de queda. Fica como fallback.
- **Heartbeat HTTP dedicado:** já existe `pingSession` (~30 s) para revogação de sessão.
  Reaproveitá-lo para presença acoplaria presença a auth, e ele **não** detecta morte do
  processo (só a ausência de pings, que é o mesmo proxy, com custo de rádio adicional).
- **MQTT 5 `Will Delay Interval`:** elegante contra flapping de reconexão, mas exige
  `clean: false` + `sessionExpiryInterval`, mudando a semântica de fila do broker para
  chat/broadcast. O `clientId` estável resolve o mesmo problema sem mexer nisso. Fica
  como evolução se o flapping aparecer em campo.

## Escopo não coberto

- A **ponte da API não persiste** presença: ela despacha `posicao`/`mensagem` e ignora
  `status` silenciosamente. Presença é estado efêmero mobile↔dashboard. Se um dia for
  preciso histórico de conexão (auditoria), aí sim persistir na ponte.
