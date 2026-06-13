import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

export default defineConfig({
  extends: [ultracite],
  ignorePatterns: [
    '.agents',
    '**/*.json',
    'dist',
    'node_modules',
    'repos/**',
    '.modern',
    '.modernjs',
    '**/@mf-types/**',
    '**/routeTree.gen.ts',
    '**/router.gen.ts',
  ],
  singleQuote: true,
});
