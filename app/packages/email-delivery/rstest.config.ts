import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  output: { distPath: path.join(tmpdir(), `ontos-email-rstest-${process.pid}`) },
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
