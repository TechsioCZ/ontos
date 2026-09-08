import { defineConfig } from '@rstest/core';

// SWC rejects every generic arrow function in `.mts` files (even `<T,>(...)`) under its
// default mts/cts parser mode, and Rstest bundles the imported scripts through SWC.
const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

const shared = {
  testEnvironment: 'node',
  testTimeout: 120_000,
  tools: { swc },
} as const;

export default defineConfig({
  projects: [
    {
      ...shared,
      exclude: ['scripts/scaffolding/**'],
      include: ['scripts/**/*.test.mts'],
      name: 'scripts',
    },
    {
      ...shared,
      include: ['scripts/scaffolding/tests/**/*.test.mts'],
      name: 'generation',
    },
    {
      ...shared,
      include: ['tools/oxlint/effect-native/tests/*.test.mts'],
      name: 'lint-rules',
    },
  ],
});
