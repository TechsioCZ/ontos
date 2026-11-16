import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      testEnvironment: 'node',
      // Four times the slowest unit test without its own budget, 714 ms in gates runs 43616061381
      // and 43844802542, instead of the silent 5000 ms Rstest default. The few tests that spawn a
      // real child process carry their own measured budget.
      testTimeout: 2856,
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      setupFiles: [new URL('../../scripts/ci/integration-worker-setup.mts', import.meta.url).pathname],
      testEnvironment: 'node',
      testTimeout: 30_000,
    },
  ],
});
