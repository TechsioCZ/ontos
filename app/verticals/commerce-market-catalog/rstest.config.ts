import { defineConfig } from '@rstest/core';

const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

// Unit tests include component tests (.tsx): JSX with the automatic runtime, as the merchandise vertical does.
const unitSwc = {
  jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { swc },
    },
    {
      include: ['tests/unit/**/*.test.{ts,tsx}'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      tools: { swc: unitSwc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
