import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/components/**/*.test.tsx'],
      name: 'component',
      testEnvironment: 'happy-dom',
      tools: {
        swc: {
          jsc: { transform: { react: { runtime: 'automatic' } } },
        },
      },
    },
    {
      include: ['tests/unit/**/*.test.{ts,tsx}'],
      name: 'unit',
      testEnvironment: 'node',
      tools: { swc: { jsc: { transform: { react: { runtime: 'automatic' } } } } },
    },
  ],
});
