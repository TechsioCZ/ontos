import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.{ts,tsx}', 'src/routes/[[]lang]/provoz/dokumenty/documents-route-state.test.ts'],
      name: 'unit',
      tools: {
        swc: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } } },
      },
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      testTimeout: 30_000,
    },
  ],
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
  tools: { swc: { jsc: { parser: { syntax: 'typescript' } } } },
});
