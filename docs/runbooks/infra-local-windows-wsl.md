# Runbook — Infra local do Cerberus no Windows 11 (+ WSL2)

Registro do que foi necessário para subir a infraestrutura de desenvolvimento do Cerberus numa máquina
**Windows 11**, incluindo os bloqueios encontrados no caminho e como contorná-los. Guarde/atualize este
documento — vários desses problemas são caros de rediagnosticar.

> **TL;DR do setup que funciona nesta máquina:** **MongoDB nativo (Windows) + Mosquitto nativo (Windows)**,
> ambos em `localhost`. O **Docker Engine roda no WSL2** e está disponível, mas **não é usado para servir a
> app** — ver [a limitação de rede](#5-limitação-docker-in-wsl-não-expõe-portas-ao-windows).

---

## Estado final (o que usar no dia a dia)

| Serviço | Onde roda | Endereço | Observação |
| --- | --- | --- | --- |
| **MongoDB** | Nativo no Windows (serviço `MongoDB`) | `mongodb://localhost:27017` | Já existia na máquina |
| **Mosquitto** | Nativo no Windows (serviço `mosquitto`) | `mqtt://localhost:1883` + `ws://localhost:9001` | Instalado via winget |
| **API / Dashboard** | Node no Windows (`npm run dev`) | API `:3000`, Dashboard `:3001` | — |
| **Docker + infra em container** | WSL2 (Ubuntu 22.04) | — | Instalado e funcional, **mas** não alcançável do Windows |

**Subir tudo (dia a dia):**
```powershell
# Mongo e Mosquitto sobem sozinhos (serviços Windows com StartType Automatic). Só rode a app:
npm run dev
```

---

## Passo a passo (com os bloqueios encontrados)

### 1. TLS quebrado (WinINET/WinHTTP) — quebrava WSL, Windows Update e a Microsoft Store

**Sintoma:** `wsl --install` e `wsl --update` falhavam com **"Erro no suporte a canais seguros"**; a
**Microsoft Store não abria** ("Algo deu errado").

**Causa:** o TLS 1.2/1.3 estava **desabilitado nos protocolos default do WinINET/WinHTTP** (não é default de
um Win11 limpo — provavelmente algum software/otimizador setou). Medições:
- `HKCU\...\Internet Settings\SecureProtocols = 0xA0` → **só SSL 3.0 + TLS 1.0**.
- WinHTTP `DefaultSecureProtocols` ausente.
- O Schannel do SO suportava TLS 1.2 (por isso o `.NET`/PowerShell baixava normalmente), mas os
  downloaders nativos (WSL, Store, Update) negociavam TLS antigo → handshake rejeitado.

**Correção (PowerShell como Administrador):**
```powershell
$tls = 0xA80   # TLS 1.0 + 1.1 + 1.2
Set-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings' SecureProtocols $tls -Type DWord
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings' SecureProtocols $tls -Type DWord
foreach ($p in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\WinHttp',
  'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Internet Settings\WinHttp')) {
  New-Item -Force $p | Out-Null
  Set-ItemProperty $p DefaultSecureProtocols 0xA80 -Type DWord
}
# Reiniciar o PC depois.
```
Isso também **conserta a Microsoft Store** (mesma causa).

### 2. Instalar o WSL2 offline (a Store estava quebrada)

Como o `wsl --install` dependia da Store/downloader, instalamos **manualmente**:

1. Habilitar recursos (Admin, sem rede):
   ```powershell
   dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
   dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
   ```
   Reiniciar.
2. Baixar (via navegador/.NET, que funcionam) e instalar o **kernel do WSL2**:
   `https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi`
3. Importar o Ubuntu a partir de um **rootfs** (sem Store, sem appx):
   ```powershell
   wsl --set-default-version 2
   # rootfs: https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz
   wsl --import Ubuntu C:\WSL\Ubuntu C:\caminho\ubuntu-2204-rootfs.tar.gz --version 2
   ```
   > Após corrigir o TLS (passo 1), o `wsl --update --web-download` também passou a funcionar.
   > Com `--import`, o usuário default é **root**.

### 3. Docker Engine dentro do WSL2

```bash
# dentro do Ubuntu (WSL)
curl -fsSL https://get.docker.com | sh
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf   # daemon sobe sozinho via systemd
```
No PowerShell: `wsl --shutdown` e reabrir o Ubuntu. Validar: `docker version && docker compose version`.

Subir a infra do projeto (**de dentro do WSL** — não há `docker` no Windows neste modelo):
```bash
cd /mnt/c/Users/<user>/dev/Cerberus && docker compose up -d
```

### 4. Firewall do Hyper-V do WSL bloqueava conexões (inbound)

**Sintoma:** processos no Windows davam `connect ETIMEDOUT` ao tentar conexão sustentada com serviços do
WSL, embora o `Test-NetConnection` (probe rápido) passasse.

**Causa:** o **firewall do Hyper-V da VM do WSL** vinha com `DefaultInboundAction = Block` (default do Win11
recente). O adaptador aparece como `vEthernet (WSL (Hyper-V firewall))`.

**Correção (Admin):**
```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

### 5. Limitação: Docker-in-WSL não expõe portas ao Windows

Mesmo com o firewall corrigido, **as portas dos containers (1883/9001) nunca ficaram acessíveis de forma
confiável a partir do Windows** — testado em NAT e em `networkingMode=mirrored`. Conexões sustentadas do
Node caíam (`ECONNREFUSED`/`ETIMEDOUT`), enquanto dentro do WSL as portas funcionavam normalmente.

> Isso é uma **limitação conhecida do modelo Docker-Engine-no-WSL** (sem Docker Desktop): os containers
> ficam na netns do Docker e o encaminhamento localhost do WSL2 não os expõe ao host Windows de forma
> estável. O **Docker Desktop** faria essa ponte automaticamente, mas foi descartado por **licença** (pago
> para organizações grandes).

**Decisão:** para o ambiente Windows, rodar os serviços **nativos** (Mongo + Mosquitto), mantendo o Docker
no WSL disponível para outros usos / paridade com produção. Alternativas válidas:
- **Desenvolver dentro do WSL** (VS Code Remote-WSL) — aí o `localhost` alcança os containers.
- **Docker Desktop** — se a licença for viável.

### 6. Mosquitto nativo no Windows

```powershell
winget install -e --id EclipseFoundation.Mosquitto   # Admin
```
Configurar os dois listeners (o default sobe só 1883, loopback) — editar
`C:\Program Files\mosquitto\mosquitto.conf` (Admin) e reiniciar o serviço:
```
listener 1883
protocol mqtt

listener 9001
protocol websockets

allow_anonymous true
```
```powershell
Restart-Service mosquitto
```
> `allow_anonymous true` é **apenas para DEV local** — em produção (DTI) usa-se auth por JWT + ACLs de
> tópico (EMQX / mosquitto-go-auth), TLS 1.3 e certificados ICP-Brasil.

### 7. MongoDB nativo

Já estava instalado (serviço Windows `MongoDB`, `localhost:27017`). Nada a fazer além de usá-lo.
> Atenção: o Mongo nativo ocupa a porta 27017 e **conflita** com o `mongo` do `docker-compose.yml` — outro
> motivo para não usar a infra Docker neste modelo.

---

## Verificação E2E (fatia vertical da Fase 1)

Com a stack nativa no ar, o fluxo **agente → API → Mongo** foi validado ao vivo:

```powershell
# 1. Subir a API (ver nota sobre .env abaixo)
#    Publicar uma posição no Mosquitto (JSON por arquivo — o PowerShell come as aspas em -m):
'{"lat":-19.9319,"lng":-43.9386,"accuracy":8,"capturedAt":"2026-07-10T05:35:00.000Z"}' | Set-Content -Encoding ascii pos.json
& 'C:\Program Files\mosquitto\mosquitto_pub.exe' -h localhost -t 'operacao/TESTOP/agente/AG-TEST/posicao' -f pos.json -q 1
```
Resultado confirmado no Mongo: documento com `location.type=Point`,
`coordinates=[-43.9386,-19.9319]` (**transposição `{lat,lng}` → `[lng,lat]` correta**), `receivedAt` gerado
no servidor e índice **`location_2dsphere`** presente.

> A cobertura automatizada desse fluxo já vive no CI: `apps/api/src/plugins/mqtt.ingest.test.ts` (ingest +
> transposição) e o E2E Playwright do dashboard (`apps/dashboard/e2e/live-map.spec.ts`).

---

## Pendências / notas importantes

- **A app NÃO carrega o `.env` automaticamente.** `api:dev` é `tsx watch src/server.ts` (sem `dotenv` nem
  `--env-file`) e `config/env.ts` lê `process.env` cru. Hoje as variáveis precisam vir do ambiente do
  shell. **Correção sugerida:** adicionar `--env-file=../../.env` (Node ≥ 20.6) aos scripts de dev da API,
  ou importar `dotenv`. Variáveis mínimas: `MONGO_URI`, `MQTT_BROKER_URL`, `JWT_SECRET`.
- **Nunca versionar credenciais de produção no `.env`.** Uma connection string de produção chegou a ficar no
  `.env` local — foi removida; **rotacionar** a credencial por precaução. Só `.env.example` é versionado.
- **Sem `docker` no Windows** neste modelo: `infra:up`/`infra:down` (que chamam `docker compose`) só rodam
  **dentro do WSL**.
- **Mobile (Fase 1)** ainda pende de verificação em device real (Expo Dev Client) — não coberto por este
  runbook.
