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

const antiSlopRules = {
  'anti-slop/no-chained-type-assertions': 'error',
  'anti-slop/no-conditional-empty-object-spread': 'error',
  'anti-slop/no-known-value-widening': 'error',
  'anti-slop/no-module-mocking': 'error',
  'anti-slop/no-object-parameters': 'error',
  'anti-slop/no-reflect-apply': 'error',
  'anti-slop/no-reflect-get': 'error',
  'anti-slop/no-runtime-typeof': 'error',
  'anti-slop/no-shape-in-symbol-names': 'error',
  'anti-slop/no-unknown-parameters': 'error',
  'anti-slop/no-unknown-returns': 'error',
  'anti-slop/no-unknown-type-aliases': 'error',
  'anti-slop/no-unsafe-dictionary-type': 'error',
  'anti-slop/no-widen-then-assert': 'error',
  'anti-slop/require-safety-comment-for-type-assertion': 'error',
};

const antiSlopEffectRules = {
  'anti-slop-effect/no-service-constructor-imports': 'error',
};

export default defineConfig({
  env: {
    browser: true,
    node: true,
  },
  extends: [core, { ...react, rules: reactRules }],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    {
      name: 'anti-slop-effect',
      specifier: './tools/oxlint/anti-slop/effect/index.ts',
    },
  ],
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
    ...antiSlopRules,
    ...antiSlopEffectRules,
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
    'tools/oxlint/anti-slop/**',
  ],
});
