import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.{ts,tsx}'],
      name: 'unit',
      testEnvironment: 'node',
      tools: { swc: { jsc: { transform: { react: { runtime: 'automatic' } } } } },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
