import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    { include: ['tests/unit/**/*.test.ts'], name: 'unit' },
    { include: ['tests/integration/**/*.test.ts'], name: 'integration', testTimeout: 30_000 },
  ],
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
  tools: { swc: { jsc: { parser: { syntax: 'typescript' } } } },
});
