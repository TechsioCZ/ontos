import { defineConfig } from '@rstest/core';

// The build defines the public origin of the module's pages (src/modern-app-env.d.ts); the unit build defines it too.
const siteUrl = { ULTRAMODERN_SITE_URL: "'http://localhost:3020'" } as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.{ts,tsx}'],
      name: 'unit',
      source: { define: siteUrl },
      testEnvironment: 'node',
      tools: { swc: { jsc: { transform: { react: { runtime: 'automatic' } } } } },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
