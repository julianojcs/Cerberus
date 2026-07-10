import { test, expect } from '@playwright/test';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import mqtt, { type MqttClient } from 'mqtt';
import { agentPositionTopic } from '@cerberus/shared';

/**
 * Fatia vertical (Fase 1) pela ótica do operador: login → mapa ao vivo recebendo
 * telemetria via MQTT. Sem backend/Docker:
 *  - REST (login, operações, snapshot) é mockada com page.route (host da API :3000);
 *  - um broker MQTT-sobre-WebSocket in-process (aedes + ws) em :9001 — a mesma URL
 *    default que o app usa (NEXT_PUBLIC_MQTT_WS_URL) — entrega uma posição RETIDA
 *    ao browser assim que ele assina, exercitando o subscribeToOperation real.
 *
 * Asserções no painel de agentes e no badge de conexão (DOM). O marcador MapLibre
 * depende de WebGL e não é o alvo da verificação.
 */

const API = 'http://localhost:3000';
const WS_PORT = 9001;
const OP_ID = '5f0000000000000000000a01';
const AGENT_ID = 'AG-0456';
const LAT = -19.9319;
const LNG = -43.9386;

let broker: Awaited<ReturnType<typeof Aedes.createBroker>>;
let wss: WebSocketServer;
let pub: MqttClient;

test.beforeAll(async () => {
  broker = await Aedes.createBroker();
  wss = new WebSocketServer({ port: WS_PORT, handleProtocols: () => 'mqtt' });
  wss.on('connection', (ws) => broker.handle(createWebSocketStream(ws)));
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));

  pub = mqtt.connect(`ws://127.0.0.1:${WS_PORT}`, { protocolVersion: 4 });
  await new Promise<void>((resolve) => pub.once('connect', () => resolve()));
});

test.afterAll(async () => {
  pub?.end(true);
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

test('login leva ao mapa ao vivo que recebe posição via MQTT', async ({ page }) => {
  // Mocks REST — host-qualified na API (:3000) para NÃO interceptar a navegação
  // do próprio Next (:3001).
  await page.route(`${API}/auth/login`, (route) =>
    route.fulfill({
      json: {
        token: 'e2e.fake.jwt',
        user: {
          id: 'u1',
          username: 'admin',
          name: 'Central de Comando',
          role: 'admin',
          agentId: undefined,
          operationIds: [OP_ID],
        },
      },
    }),
  );
  await page.route(`${API}/operations`, (route) =>
    route.fulfill({
      json: [
        {
          id: OP_ID,
          name: 'Operação Cérbero (Demo)',
          type: 'escolta',
          status: 'ativa',
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await page.route(`${API}/operations/*/positions/latest`, (route) => route.fulfill({ json: [] }));

  // Publica uma posição RETIDA: o broker a entrega ao browser no instante em que
  // ele assina `operacao/{id}/#` — elimina a corrida de timing.
  pub.publish(
    agentPositionTopic(OP_ID, AGENT_ID),
    JSON.stringify({
      lat: LAT,
      lng: LNG,
      battery: 0.87,
      activity: 'in_vehicle',
      capturedAt: new Date().toISOString(),
    }),
    { qos: 1, retain: true },
  );

  // Login (credenciais já pré-preenchidas no formulário).
  await page.goto('/login');
  await page.getByRole('button', { name: 'Entrar' }).click();

  // Redireciona para a lista e mostra a operação mockada.
  await expect(page).toHaveURL(/\/operations$/);
  await page.getByRole('link', { name: /Operação Cérbero \(Demo\)/ }).click();

  // Mapa ao vivo: a posição publicada via MQTT aparece no painel e conecta o badge.
  await expect(page).toHaveURL(new RegExp(`/operations/${OP_ID}/live$`));
  await expect(page.getByText(AGENT_ID)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${LAT.toFixed(5)}, ${LNG.toFixed(5)}`)).toBeVisible();
  await expect(page.getByText('barramento conectado')).toBeVisible();
});
