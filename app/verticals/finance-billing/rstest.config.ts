import { defineConfig } from '@rstest/core';

// The build defines the public origin of the module's pages (src/modern-app-env.d.ts); the unit build defines it too.
const siteUrl = { ULTRAMODERN_SITE_URL: "'http://localhost:3020'" } as const;

const swc = {
  jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
} as const;

export default defineConfig({
  projects: [
    // Mounted form tests opt into happy-dom per file (`// @rstest-environment happy-dom`); the rest run in node.
    { include: ['tests/unit/**/*.test.{ts,tsx}'], name: 'unit', source: { define: siteUrl }, tools: { swc } },
    { include: ['tests/integration/**/*.test.ts'], name: 'integration', testTimeout: 30_000, tools: { swc } },
  ],
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
});
