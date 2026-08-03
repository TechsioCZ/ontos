import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const referenceTopology = JSON.parse(
  readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8'),
) as unknown;

export default defineConfig({
  clearMocks: true,
  extends: withModernConfig({
    configPath: './modern.rstest.config.ts',
  }),
  include: ['tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  output: {
    module: false,
  },
  restoreMocks: true,
  source: {
    define: {
      ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: JSON.stringify(referenceTopology),
      ULTRAMODERN_SITE_URL: JSON.stringify('http://localhost:3020'),
    },
  },
  testEnvironment: 'happy-dom',
});
