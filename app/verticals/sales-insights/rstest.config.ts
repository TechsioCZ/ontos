import { defineConfig } from '@rstest/core';

const swc = {
  jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
} as const;

export default defineConfig({
  include: ['tests/unit/**/*.test.ts'],
  name: 'unit',
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
  tools: { swc },
});
