import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';
import * as Schema from 'effect/Schema';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const referenceTopology = decodeJson(
  JSON.parse(
    readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8'),
  ),
);
const developmentOverlay = decodeJson(
  JSON.parse(
    readFileSync(
      new URL('../../topology/local-overlays/development.json', import.meta.url),
      'utf-8',
    ),
  ),
);

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
      ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: JSON.stringify({
        environment: 'development',
        overlay: developmentOverlay,
        topology: referenceTopology,
      }),
      ULTRAMODERN_SITE_URL: JSON.stringify('http://localhost:3020'),
    },
  },
  testEnvironment: 'happy-dom',
  tools: {
    rspack: {
      // Load the provider natively; Rstest's CJS wrapper corrupts its async dependency graph.
      externals: { 'better-auth': 'commonjs better-auth' },
    },
  },
});
