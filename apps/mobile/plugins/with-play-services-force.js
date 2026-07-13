const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Força a versão de `com.google.android.gms:play-services-location` em **20.0.0** no
 * `android/build.gradle`, via `resolutionStrategy` dentro de `allprojects`.
 *
 * Por quê: o AAR do `react-native-background-geolocation` (4.18) foi compilado
 * contra a play-services-location **20.0.0** (onde `FusedLocationProviderClient` /
 * `ActivityRecognitionClient` são **classes**). O `react-native-maps` puxa a
 * **21.0.1** (onde viraram **interfaces**) e o Gradle resolve 21.0.1 → o app crasha
 * com `java.lang.IncompatibleClassChangeError` ao INICIAR o rastreio (GPS).
 *
 * Config plugin (em vez de editar `android/`, que é gitignored e regenerado pelo
 * prebuild): a correção sobrevive a `expo prebuild --clean`, a checkouts limpos e a
 * builds de CI/EAS. Ver a regra irmã em plugins/with-kotlin-classpath.js.
 */
const FORCE_MARKER = 'play-services-location:20.0.0';

const FORCE_BLOCK = `    configurations.all {
        resolutionStrategy {
            // react-native-background-geolocation (4.18) foi compilado contra a
            // play-services-location 20.0.0 (classes); react-native-maps força 21.0.1
            // (interfaces) → IncompatibleClassChangeError ao iniciar o GPS. Fixa 20.0.0.
            force 'com.google.android.gms:play-services-location:20.0.0'
        }
    }`;

/**
 * Transform puro (testável): injeta o bloco de `force` dentro de `allprojects {`.
 * Idempotente — se o `force` já existe, devolve o conteúdo inalterado. Se não houver
 * um `allprojects {` (template atípico), acrescenta um bloco próprio no fim.
 */
function withPlayServicesForceGradle(contents) {
  if (contents.includes(FORCE_MARKER)) return contents;
  if (/allprojects\s*\{/.test(contents)) {
    return contents.replace(/allprojects\s*\{/, (match) => `${match}\n${FORCE_BLOCK}\n`);
  }
  return `${contents}\nallprojects {\n${FORCE_BLOCK}\n}\n`;
}

const withPlayServicesForce = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;
    cfg.modResults.contents = withPlayServicesForceGradle(cfg.modResults.contents);
    return cfg;
  });

module.exports = withPlayServicesForce;
module.exports.withPlayServicesForceGradle = withPlayServicesForceGradle;
