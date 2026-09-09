import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      testEnvironment: 'node',
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      testEnvironment: 'node',
      testTimeout: 30_000,
    },
  ],
});
