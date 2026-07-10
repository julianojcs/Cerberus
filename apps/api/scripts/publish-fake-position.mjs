// Simula um agente publicando telemetria via MQTT — verifica a fatia vertical
// sem precisar do celular. Faz um marcador "caminhar" ao redor de um ponto.
//
// Uso:
//   OPERATION_ID=<id> AGENT_ID=AG-0456 node apps/api/scripts/publish-fake-position.mjs
//   (defaults: broker mqtt://localhost:1883, agentId AG-0456, ponto em Belo Horizonte)
import mqtt from 'mqtt';

const BROKER = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
const OPERATION_ID = process.env.OPERATION_ID;
const AGENT_ID = process.env.AGENT_ID ?? 'AG-0456';

if (!OPERATION_ID) {
  console.error('Defina OPERATION_ID (veja a saída de `npm run api:seed`).');
  process.exit(1);
}

const topic = `operacao/${OPERATION_ID}/agente/${AGENT_ID}/posicao`;
// Praça da Liberdade, Belo Horizonte - MG (ponto de partida do passeio simulado).
let lat = -19.9319;
let lng = -43.9386;
let step = 0;

const client = mqtt.connect(BROKER, { clientId: `fake_agent_${AGENT_ID}` });

client.on('connect', () => {
  console.log(`Conectado a ${BROKER}. Publicando em ${topic} a cada 2s (Ctrl+C para parar).`);
  setInterval(() => {
    // Deriva ~0.05° em círculo lento para simular deslocamento.
    step += 1;
    lat += Math.sin(step / 8) * 0.0004;
    lng += Math.cos(step / 8) * 0.0004;

    const payload = {
      lat,
      lng,
      accuracy: 8,
      speed: 4.2,
      heading: (step * 15) % 360,
      battery: Math.max(0.2, 1 - step * 0.01),
      activity: 'in_vehicle',
      capturedAt: new Date().toISOString(),
    };
    client.publish(topic, JSON.stringify(payload), { qos: 1 });
    console.log(`-> pos #${step}: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  }, 2000);
});

client.on('error', (err) => {
  console.error('Erro MQTT:', err.message);
  process.exit(1);
});
