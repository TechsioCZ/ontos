import { defineConfig } from 'oxlint';

/** The operator/discriminant policy also covers tooling and root configuration files. */
export default defineConfig({
  jsPlugins: [{ name: 'effect-native', specifier: './index.ts' }],
  categories: { correctness: 'off' },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.output/**',
    '**/dist-cloudflare/**',
    '**/.modern-js/**',
    '**/@mf-types/**',
    '**/repos/**',
    '**/tools/oxlint/**/tests/fixtures/**',
  ],
  rules: {
    'effect-native/no-instanceof': 'error',
    'effect-native/no-manual-tag-comparison': ['error', { include: ['**'], adtTags: [] }],
  },
});
