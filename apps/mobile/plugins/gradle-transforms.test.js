const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withKotlinClasspathGradle } = require('./with-kotlin-classpath');
const { withPlayServicesForceGradle } = require('./with-play-services-force');

/**
 * Testes das transforms puras dos config plugins nativos do Android. Rodar com:
 *   node --test apps/mobile/plugins
 * (o app móvel fica fora do Vitest do monorepo; estes são testes Node puros.)
 */
const BUILD_GRADLE = `buildscript {
    dependencies {
        classpath('com.android.tools.build:gradle')
        classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
    }
}
allprojects {
    repositories {
        google()
        mavenCentral()
    }
}
`;

const FORCE_LINE = "force 'com.google.android.gms:play-services-location:20.0.0'";

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('kotlin: fixa o classpath do kotlin-gradle-plugin em $kotlinVersion', () => {
  const out = withKotlinClasspathGradle(BUILD_GRADLE);
  assert.ok(out.includes('classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")'));
  assert.ok(!out.includes("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')"));
});

test('kotlin: idempotente (aplicar 2x não muda nem duplica)', () => {
  const once = withKotlinClasspathGradle(BUILD_GRADLE);
  const twice = withKotlinClasspathGradle(once);
  assert.equal(twice, once);
  assert.equal(count(twice, 'kotlin-gradle-plugin:$kotlinVersion'), 1);
});

test('play-services: injeta o force dentro de allprojects', () => {
  const out = withPlayServicesForceGradle(BUILD_GRADLE);
  assert.ok(out.includes(FORCE_LINE));
  // O bloco deve cair DENTRO de allprojects (antes do repositories original).
  const idxAllprojects = out.indexOf('allprojects {');
  const idxForce = out.indexOf(FORCE_LINE);
  const idxRepos = out.indexOf('repositories {');
  assert.ok(idxAllprojects < idxForce && idxForce < idxRepos);
});

test('play-services: idempotente (aplicar 2x não duplica o force)', () => {
  const once = withPlayServicesForceGradle(BUILD_GRADLE);
  const twice = withPlayServicesForceGradle(once);
  assert.equal(twice, once);
  assert.equal(count(twice, FORCE_LINE), 1);
});

test('play-services: fallback com bloco próprio quando não há allprojects', () => {
  const semAllprojects = 'buildscript {\n    dependencies {\n    }\n}\n';
  const out = withPlayServicesForceGradle(semAllprojects);
  assert.ok(out.includes('allprojects {'));
  assert.ok(out.includes(FORCE_LINE));
  // idempotente também no caminho de fallback
  assert.equal(withPlayServicesForceGradle(out), out);
});
