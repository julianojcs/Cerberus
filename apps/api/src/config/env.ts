import { z } from 'zod';

/**
 * Leitura e validação de variáveis de ambiente (12-factor). O código abstrai
 * completamente a infraestrutura: trocar MVP (Render/Atlas/HiveMQ) por
 * produção DTI (K8s/ReplicaSet/EMQX) é apenas questão de `.env`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  MONGO_URI: z.string().min(1, 'MONGO_URI é obrigatório'),

  MQTT_BROKER_URL: z.string().min(1, 'MQTT_BROKER_URL é obrigatório'),
  MQTT_CLIENT_ID: z.string().default('cerberus_api_node'),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),

  JWT_SECRET: z.string().min(8, 'JWT_SECRET deve ter ao menos 8 caracteres'),
  JWT_EXPIRES_IN: z.string().default('8h'),

  /**
   * Motor de rotas (issue #131). O padrão é o OSRM público, que serve para
   * DESENVOLVIMENTO — não tem SLA e o uso pesado é desencorajado. Em produção isto
   * aponta para uma API de rotas gerenciada (ver `modules/navigation/provider.ts`);
   * auto-hospedar OSRM está fora de cogitação porque exigiria Docker.
   */
  OSRM_BASE_URL: z.string().default('https://router.project-osrm.org'),
  /** Timeout (ms) do provedor de rotas. Estourou ⇒ despacha a linha reta. */
  ROUTING_TIMEOUT_MS: z.coerce.number().default(10_000),

  /**
   * Geocodificação (endereço ↔ coordenada). Nominatim público em desenvolvimento; em
   * produção sai junto com o provedor de rotas gerenciado, na mesma chave.
   */
  NOMINATIM_BASE_URL: z.string().default('https://nominatim.openstreetmap.org'),
  /**
   * A política do Nominatim EXIGE um User-Agent identificando a aplicação, com contato
   * — requisição sem isso é recusada. Trocar o e-mail pelo do responsável antes de
   * qualquer uso sério.
   */
  GEOCODING_USER_AGENT: z.string().default('Cerberus/1.0 (contato: devsrnbtlls@gmail.com)'),
  /** Restringe a busca a países (ISO 3166-1 alpha-2). Vazio = mundo todo. */
  GEOCODING_COUNTRY_CODES: z.string().default('br'),

  /**
   * Controle da simulação pelo dashboard (issue #134). Habilita os endpoints que fazem
   * a API GERAR telemetria falsa (só para a operação SIMULAÇÃO, só admin). É uma trava
   * de segurança: em produção REAL isto fica desligado, para o servidor nunca poder
   * forjar posição de agente. Ligar apenas em dev/homologação (`SIMULATION_ENABLED=true`).
   * Coerção explícita: só `'true'`/`'1'` habilitam — `z.coerce.boolean('false')` daria
   * `true` (string não-vazia), então NÃO usar coerce aqui.
   */
  SIMULATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
