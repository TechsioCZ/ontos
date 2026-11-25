import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/*.test.ts'],
      name: 'unit',
      testEnvironment: 'node',
    },
  ],
});
