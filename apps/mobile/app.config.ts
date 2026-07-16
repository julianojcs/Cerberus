import type { ExpoConfig } from 'expo/config';

/**
 * Configuração do app móvel de campo.
 *
 * O `react-native-background-geolocation` (Transistor Software) é um módulo
 * NATIVO — exige um Expo Dev Client / EAS Build (não roda no Expo Go). O config
 * plugin abaixo injeta as permissões e o modo de localização em background.
 *
 * Licenciamento (conforme spec): em homologação (MVP) roda em modo debug sem
 * restrições; para o binário oficial usa-se o plano Starter com 1 Application Key
 * validando o `bundleId`/`package` corporativo — informe via variável de ambiente.
 */
const config: ExpoConfig = {
  name: 'Cerberus Agente',
  slug: 'cerberus-agente',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'cerberus',
  userInterfaceStyle: 'dark',
  // Ícone do app = logo principal do sistema (cópia de assets/brand/logo.png).
  // Recomendado um mestre 1024x1024 quadrado; a atual é retangular (será ajustada).
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: 'br.gov.pf.cerberus.agente',
    supportsTablet: true, // iPhones e iPads (conforme spec)
    infoPlist: {
      UIBackgroundModes: ['location', 'fetch'],
      NSLocationWhenInUseUsageDescription:
        'O Cerberus usa sua localização para consciência situacional tática da operação.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'O Cerberus reporta sua posição em segundo plano durante operações ativas.',
    },
  },
  android: {
    package: 'br.gov.pf.cerberus.agente',
    adaptiveIcon: {
      // Foreground = logo centralizada em ~66% (zona segura do adaptativo, gerada
      // por scripts/make-icons.mjs) sobre fundo branco (a logo é para fundo claro,
      // igual ao ícone do iOS). Evita o corte das bordas pelo launcher.
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
      // Doze: com o aparelho ocioso o Android ADIA os alarmes para janelas de
      // manutenção cada vez mais espaçadas — e o heartbeat do GPS (5 min) é um alarme,
      // então vira 30/60 min e a central vê o agente congelado mesmo conectado. O
      // `foregroundService` impede o app de ser MORTO, mas não o isenta do Doze. Esta
      // permissão habilita PEDIR a isenção ao operador (ver services/geolocation.ts).
      'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    ],
  },
  plugins: [
    [
      'react-native-background-geolocation',
      {
        // Chave de licença do binário oficial (Starter). Vazio em modo debug/MVP.
        license: process.env.BACKGROUND_GEOLOCATION_LICENSE ?? '',
      },
    ],
    'react-native-background-fetch',
    'expo-notifications',
    [
      'expo-image-picker',
      {
        cameraPermission: 'O Cerberus usa a câmera para registrar mídia tática da operação.',
        photosPermission: 'O Cerberus acessa fotos para enviar mídia tática da operação.',
      },
    ],
    // Alinha o Kotlin do classpath (1.9.25) ao exigido pelo Compose do
    // expo-modules-core — ver plugins/with-kotlin-classpath.js.
    './plugins/with-kotlin-classpath',
    // Fixa play-services-location em 20.0.0 (compatível com o background-geolocation)
    // — evita IncompatibleClassChangeError ao iniciar o GPS. Ver
    // plugins/with-play-services-force.js.
    './plugins/with-play-services-force',
  ],
  extra: {
    // Sem fallback: quando não definido, o app deriva o host do Metro
    // automaticamente (ver src/config.ts). Definir só para túnel/produção.
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    mqttWsUrl: process.env.EXPO_PUBLIC_MQTT_WS_URL,
    // Credencial estática do broker gerenciado (HiveMQ Cloud não faz auth JWT).
    // Quando definida, o app conecta com ela; senão usa jwt+token (on-prem).
    mqttUsername: process.env.EXPO_PUBLIC_MQTT_USERNAME,
    mqttPassword: process.env.EXPO_PUBLIC_MQTT_PASSWORD,
  },
};

export default config;
