import { defineConfig } from 'oxfmt';

export default defineConfig({
  printWidth: 120,
  trailingComma: 'all',
  ignorePatterns: [
    '.agents',
    '.codex/skills',
    '.output',
    '**/*.json',
    'dist',
    'node_modules',
    'repos/**',
    '.modern',
    '.modernjs',
    '**/modern-tanstack/**',
    '**/routeTree.gen.*',
    'tools/oxlint/anti-slop/**',
    // Fixtures intentionally preserve syntax variants and source positions.
    'tools/oxlint/effect-native/tests/fixtures/**',
  ],
  singleQuote: true,
});
