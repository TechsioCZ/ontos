import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [{ include: ['tests/unit/**/*.test.ts'], name: 'unit', testEnvironment: 'node' }],
});
