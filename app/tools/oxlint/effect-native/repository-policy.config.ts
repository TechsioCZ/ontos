import { defineConfig } from 'oxlint';

/** Repository policies also cover tooling tests and root configuration files. */
export default defineConfig({
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
  jsPlugins: [{ name: 'effect-native', specifier: './index.ts' }],
  overrides: [
    {
      files: ['tools/**/tests/**'],
      rules: {
        'effect-native/no-effect-run-in-tests': 'error',
        'eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              { message: 'Import test APIs from @app/effect-rstest instead.', name: 'node:test' },
              {
                message: 'Import assertions from @app/effect-rstest instead.',
                name: 'node:assert',
              },
              {
                message: 'Import assertions from @app/effect-rstest instead.',
                name: 'node:assert/strict',
              },
              {
                message: 'Import test APIs from @app/effect-rstest instead.',
                name: '@rstest/core',
              },
            ],
          },
        ],
      },
    },
  ],
  rules: {
    'effect-native/no-instanceof': 'error',
    'effect-native/no-manual-tag-comparison': ['error', { adtTags: [], include: ['**'] }],
  },
});
