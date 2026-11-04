import { defineConfig } from 'oxlint';

import { testRestrictedImports } from './shared/test-restricted-imports.ts';

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
      // Next.js storefronts use native Error subclasses at their Promise/UI boundary, not Effect failures.
      files: ['**/akros-storefront/**', '**/n1-storefront/**'],
      rules: { 'effect-native/no-instanceof': 'off' },
    },
    {
      files: ['tools/**/tests/**'],
      rules: {
        'effect-native/no-effect-run-in-tests': 'error',
        'eslint/no-restricted-imports': [
          'error',
          {
            paths: testRestrictedImports,
          },
        ],
      },
    },
  ],
  rules: {
    'effect-native/no-instanceof': 'error',
    'effect-native/no-manual-tag-comparison': ['error', { adtTags: [], ignoreTests: true, include: ['**'] }],
  },
});
