import { defineConfig } from '@rstest/core';

const swc = {
  jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
} as const;

export default defineConfig({
  projects: [
    { include: ['tests/unit/**/*.test.ts'], name: 'unit', tools: { swc } },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      setupFiles: ['../../scripts/ci/integration-worker-setup.mts'],
      testTimeout: 30_000,
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
  tools: { swc },
});
