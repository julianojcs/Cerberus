const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Fixa a versão do plugin Gradle do Kotlin no classpath do `android/build.gradle`
 * para a `ext.kotlinVersion` (Expo SDK 52 = 1.9.25).
 *
 * Por quê: o catálogo de versões do React Native 0.76 define kotlin = 1.9.24, e o
 * `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')` gerado pelo prebuild NÃO
 * fixa versão — então resolve 1.9.24. Mas o Compose Compiler (1.5.15) do
 * `expo-modules-core` exige Kotlin 1.9.25, e `:expo-modules-core:compileDebugKotlin`
 * falha ("Compose Compiler ... requires Kotlin version 1.9.25 but you appear to be
 * using 1.9.24"). Pinar o classpath em `$kotlinVersion` (1.9.25) alinha tudo.
 *
 * Config plugin (em vez de editar android/, que é gitignored e regenerado pelo
 * prebuild): a correção sobrevive a `expo prebuild --clean`.
 */
const withKotlinClasspath = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /classpath\((['"])org\.jetbrains\.kotlin:kotlin-gradle-plugin\1\)/,
      'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")',
    );
    return cfg;
  });

module.exports = withKotlinClasspath;
