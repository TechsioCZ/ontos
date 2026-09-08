import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

export default defineConfig({
  ...ultracite,
  printWidth: 100,
  proseWrap: 'preserve',
  trailingComma: 'all',
  sortImports: false,
  sortPackageJson: false,
  sortTailwindcss: false,
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
