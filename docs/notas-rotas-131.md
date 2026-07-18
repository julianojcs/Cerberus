# Issue #131 — decisões tomadas e dúvidas em aberto

Anotações da sessão de implementação autônoma (18/07/2026). Onde havia ambiguidade,
apliquei a opção recomendada e registrei aqui. **Este arquivo é para revisão — apague-o
ou converta em ADR depois que conversarmos.**

---

## Dúvidas que precisam da sua decisão

### 1. A branch saiu de `feat/foot-marker-navigation2`, não de `main`

`feat/route-navigation` foi criada a partir do HEAD da branch em que você estava, porque
havia trabalho **não commitado** na árvore (o simulador de agentes, `live/page.tsx`,
`package.json` do mobile, `favicon_1.png`). Sair para `main` arrastaria essas mudanças e
poderia conflitar.

Consequência: a branch de rotas inclui os commits de marcador a pé. Isso combina com o
padrão de PR empilhado que você já usou (#81→#85), mas **se você quiser o PR de rotas
independente**, é preciso rebasear em `main` depois que o de marcador entrar.

**Nada do seu trabalho não commitado foi tocado nem commitado.** Continua tudo lá.

### 2. Qual provedor de rotas em produção

O `.env` aponta para o OSRM público por padrão (`OSRM_BASE_URL`). Serve para desenvolver,
mas não tem SLA. O adaptador está atrás da interface `RoutingProvider`, então trocar é
escrever uma classe nova e mudar a variável de ambiente.

Candidatos, todos com tier gratuito folgado para o volume desta feature (dezenas a poucas
centenas de chamadas/dia): **OpenRouteService**, **GraphHopper**, **Mapbox Directions**,
**Stadia/Valhalla**. Não cravei nenhum porque os limites mudam e eu não tinha como
conferir os números vigentes. Decidir antes de ir a campo.

### 3. Recálculo por desvio ficou no SERVIDOR, não no app

Você pediu turn-by-turn completo com recálculo. Implementei a detecção de desvio na ponte
de ingest (`modules/navigation/track.ts`), não no aparelho.

**Por quê:** o servidor sempre tem a posição (ela acabou de chegar) e sempre tem rede; o
aparelho em campo pode estar sem sinal justamente quando o desvio acontece. Assim a rota
recalculada chega sozinha ao agente quando ele reconecta.

**Se você preferir no app** (resposta mais rápida, sem esperar o ciclo de telemetria), o
endpoint `POST /operations/:id/routes/:routeId/recalculate` já existe e o agente tem
permissão de chamá-lo para si mesmo. É só ligar no mobile.

### 4. Limiares chutados — validar em campo

Em `packages/shared/src/constants.ts`:

- `ROUTE_DEVIATION_METERS = 50` — distância do traçado que conta como desvio
- `ROUTE_ARRIVAL_METERS = 30` — raio que marca chegada
- `DEVIATION_STRIKES_TO_RECALCULATE = 2` (em `track.ts`) — posições fora seguidas antes de recalcular

Escolhidos por raciocínio (erro típico de GPS urbano 5–20 m, largura de pistas paralelas),
**não medidos**. Provavelmente querem ajuste depois de rodar de verdade.

### 5. Bateria no turn-by-turn — NÃO resolvido

Sinalizei isso na conversa e **continua pendente**. Turn-by-turn precisa de GPS em alta
frequência, o que briga com a estratégia atual de hibernação + heartbeat de 5 min
(`services/geolocation.ts`). Não mexi nessa política.

Sem um modo de amostragem dedicado enquanto há rota ativa, ou o turn-by-turn fica com
atualização grosseira demais para ser útil, ou a bateria do agente derrete. É a maior
lacuna técnica que sobrou.

---

## Decisões que tomei sozinho (e o porquê)

| Decisão | Alternativa descartada | Motivo |
|---|---|---|
| Comando MQTT leva só `routeId` | Mandar a geometria no payload | Canal `comando` exige payload mínimo; geometria com `steps` passa de dezenas de KB |
| Módulo chamado `navigation` | `routes` | `lib/routes.ts` já significa **rastro percorrido**; colidir os nomes é a confusão mais provável da feature |
| Instruções pt-BR escritas à mão | `osrm-text-instructions` | A lib é CommonJS sem tipos e acoplada ao vocabulário do OSRM — trocar de provedor obrigaria a trocar a lib. São ~15 frases |
| `Route` é coleção nova | Estender `Geofence` | Zona é área com gatilho enter/exit; rota é trajeto com progresso e ciclo de vida |
| Rota nova aposenta a anterior (`SUBSTITUIDA`) | Permitir várias ativas | Com duas ativas, a detecção de desvio não sabe contra qual traçado medir |
| `SUBSTITUIDA` ≠ `CANCELADA` | Um só estado final | Recálculo não é desistência do destino; o histórico precisa distinguir |
| Rota de fallback **isenta** de desvio | Tratar igual | A linha reta ignora ruas: um motorista fica sempre "fora" dela, e cada recálculo cairia no mesmo fallback — laço que não converge |
| `201` mesmo com barramento fora | `503` | A rota fica persistida e o app a recupera em `GET /routes/active` ao reconectar; falhar jogaria fora o cálculo por uma indisponibilidade contornável |
| Origem nunca vem do corpo | Aceitar `origin` do cliente | Permitiria traçar rota a partir de onde o agente não está |
| Dashboard sonda rotas a cada 20 s | Só recarregar em ação do operador | O recálculo nasce no servidor; sem sondar, o mapa mostraria traçado velho |

---

## O que ficou pronto

**API** — modelo `Route` (2dsphere + índice `{operationId, agentId, status}`), contratos em
`@cerberus/shared`, motor de rotas com fallback, 6 endpoints REST escopados, chegada e
recálculo automático na ponte de ingest. **44 testes novos; 195 no total, sem regressão.**

**Dashboard** — modo "definir destino" (clique no mapa), painel de despacho com agente +
rótulo, camada da rota planejada (com contorno, acima do rastro), pino de destino,
tracejado para traçado direto, lista de rotas ativas com cancelar e enquadrar.

**Mobile** — fases 4/5/6b, ver relatório do subagente e o commit correspondente.
