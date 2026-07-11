# App de Campo — Conexão por WiFi (sem cabo USB)

O app do agente é um **Expo Dev Client** (o `react-native-background-geolocation` é
nativo, não roda no Expo Go). Depois de instalado o dev client no aparelho **uma
vez** (via USB ou APK), todo o ciclo de desenvolvimento roda **por WiFi** — celular e
PC na **mesma rede**.

O app **não precisa de configuração de IP**: `src/config.ts` deriva o host da API
(`:3000`) e do broker MQTT (`:9001`) do **mesmo IP do Metro** (`hostUri`). Trocou de
rede, nada a editar — basta o Metro subir em modo LAN.

## 1. Subir os serviços no PC (uma vez)

```bash
npm run infra:up            # (na raiz) MongoDB + Mosquitto (broker MQTT)
npm run api:dev             # (na raiz) API em :3000
cd apps/mobile && npm start # Metro em modo --lan (WiFi)
```

> `apps/mobile` → `npm start` já usa `expo start --dev-client --lan` (WiFi).
> Rede diferente (4G/roteador isolado)? Em `apps/mobile`, use `npm run start:tunnel`
> (Expo Tunnel).

## 2. Liberar as portas no firewall do PC

O aparelho precisa **alcançar o PC** na LAN. Libere no Firewall do Windows (uma vez):

- **8081** — Metro (bundle JS)
- **3000** — API Cerberus
- **9001** — MQTT sobre WebSocket (broker)

```powershell
New-NetFirewallRule -DisplayName "Cerberus dev (LAN)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8081,3000,9001
```

Confirme que **API e broker escutam na LAN** (`0.0.0.0`), não só em `localhost`.

## 3. Conectar o aparelho por WiFi

**JS/Metro (bundle):** abra o **dev client** no celular e aponte para a URL do Metro
(`exp://<IP-do-PC>:8081`) — escaneie o QR do terminal ou digite o IP. Pronto: recargas
e Fast Refresh viajam por WiFi.

**ADB por WiFi (logs/instalação Android, opcional — evita o cabo):**

- **Android 11+** (pareamento sem fio): _Opções do desenvolvedor → Depuração por
  Wi‑Fi → Parear com código_, e no PC:
  ```bash
  adb pair <IP-do-celular>:<porta-de-pareamento>
  adb connect <IP-do-celular>:<porta-de-depuração>
  ```
- **Com um cabo só desta vez** (herda a conexão para WiFi):
  ```bash
  adb tcpip 5555
  adb connect <IP-do-celular>:5555   # agora pode desconectar o USB
  ```

Descubra o IP do celular em _Configurações → Wi‑Fi → (rede) → Avançado_, ou
`adb shell ip -f inet addr show wlan0`.

## Notificação em segundo plano

Com o **Rastreamento (GPS) ligado**, o app roda como *foreground service* e fica
**sempre visível na barra de notificações** (mesmo minimizado): "Cerberus — Operação
ativa". A notificação é fixa (`sticky`) e usa o canal "Rastreamento Cerberus"
(ajustável em _Configurações → Apps → Cerberus Agente → Notificações_). Ver
`apps/mobile/src/services/geolocation.ts`.
