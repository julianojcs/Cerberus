// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Config única (flat) do monorepo Cerberus.
 * Cobre packages/shared, apps/api e apps/dashboard.
 * apps/mobile fica fora (projeto Expo separado, não instalado no CI — terá lint próprio).
 * Regras "recommended" sem type-checking: rápido, robusto e sem depender de tsconfig por arquivo.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      'apps/mobile/**',
      'packages/shared/dist/**',
      '**/next-env.d.ts', // gerado pelo Next (triple-slash intencional)
      '**/*.config.{js,cjs,mjs,ts}',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
);
