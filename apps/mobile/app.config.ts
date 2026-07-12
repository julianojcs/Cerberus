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
      foregroundImage: './assets/icon.png',
      backgroundColor: '#0b0f14', // fundo institucional escuro (var --bg)
    },
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
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
  ],
  extra: {
    // Sem fallback: quando não definido, o app deriva o host do Metro
    // automaticamente (ver src/config.ts). Definir só para túnel/produção.
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    mqttWsUrl: process.env.EXPO_PUBLIC_MQTT_WS_URL,
  },
};

export default config;
