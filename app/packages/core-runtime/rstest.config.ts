import { defineConfig } from '@rstest/core';

export default defineConfig({
  // Integration repositories match the shared database outbox globally.
  // Rstest only supports a root pool, so the whole package runs serially to prevent
  // independent subscription catalogs from consuming each other.
  pool: { maxWorkers: 1 },
  projects: [
    { include: ['tests/unit/**/*.test.ts'], name: 'unit', testEnvironment: 'node' },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      testEnvironment: 'node',
      testTimeout: 30_000,
    },
  ],
});
