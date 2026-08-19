import { defineConfig } from 'oxlint';
import core from 'ultracite/oxlint/core';
import react from 'ultracite/oxlint/react';

// oxlint 1.79.0 removed the nursery react/react-compiler rule and replaced it
// with dedicated React Compiler rules (https://oxc.rs/blog/2026-08-18-react-compiler-support).
// ultracite 7.9.3 still enables the removed rule, so it is stripped from the
// preset until ultracite ships an oxlint 1.79-compatible release.
const reactRules = Object.fromEntries(
  Object.entries(react.rules ?? {}).filter(([name]) => name !== 'react/react-compiler'),
);

export default defineConfig({
  env: {
    browser: true,
    node: true,
  },
  extends: [core, { ...react, rules: reactRules }],
  rules: {
    // React Compiler correctness rules — the recommended set from the
    // oxc.rs 2026-08-18 announcement, pinned explicitly to match the
    // ultracite presets' explicit-rules philosophy.
    'react/error-boundaries': 'error',
    'react/globals': 'error',
    'react/immutability': 'error',
    'react/incompatible-library': 'error',
    'react/preserve-manual-memoization': 'error',
    'react/purity': 'error',
    'react/refs': 'error',
    'react/set-state-in-effect': 'error',
    'react/set-state-in-render': 'error',
    'react/static-components': 'error',
    'react/use-memo': 'error',
    'react/void-use-memo': 'error',
  },
  ignorePatterns: [
    '.agents',
    '.codex/skills',
    '.output',
    'dist',
    'node_modules',
    'repos/**',
    '.modern',
    '.modernjs',
    '**/modern-tanstack/**',
    '**/routeTree.gen.*',
  ],
});
