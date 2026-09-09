import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';
import type { Rspack } from '@rstest/core';
import { Result, Schema } from 'effect';

import {
  DeploymentAllowlistOverlaySchema,
  DeploymentAllowlistTopologySchema,
} from './api/modules/deployment-allowlist.ts';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const topologyJsonSchema = Schema.fromJsonString(DeploymentAllowlistTopologySchema);
const overlayJsonSchema = Schema.fromJsonString(DeploymentAllowlistOverlaySchema);
const moduleDeploymentAllowlistJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    environment: Schema.Literal('development'),
    overlay: DeploymentAllowlistOverlaySchema,
    topology: DeploymentAllowlistTopologySchema,
  }),
);
const siteUrlJsonSchema = Schema.fromJsonString(Schema.String);
const referenceTopology = Result.getOrThrow(
  Schema.decodeUnknownResult(topologyJsonSchema, {
    onExcessProperty: 'preserve',
  })(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
);
const developmentOverlay = Result.getOrThrow(
  Schema.decodeUnknownResult(overlayJsonSchema, {
    onExcessProperty: 'preserve',
  })(readFileSync(new URL('../../topology/local-overlays/development.json', import.meta.url), 'utf-8')),
);
const encodeOptions = { onExcessProperty: 'preserve' } as const;
const encodedReferenceTopology = Result.getOrThrow(
  Schema.encodeResult(topologyJsonSchema, encodeOptions)(referenceTopology),
);
const encodedModuleDeploymentAllowlist = Result.getOrThrow(
  Schema.encodeResult(
    moduleDeploymentAllowlistJsonSchema,
    encodeOptions,
  )({
    environment: 'development',
    overlay: developmentOverlay,
    topology: referenceTopology,
  }),
);
const encodedSiteUrl = Result.getOrThrow(Schema.encodeResult(siteUrlJsonSchema)('http://localhost:3020'));

const coreRuntimeRoot = fileURLToPath(new URL('../../packages/core-runtime/', import.meta.url));
// Generated owner modules are imported natively from disk, so core-runtime must be one Node
// instance shared by the test bundle and those modules (brand symbols, private fields).
const externalizeCoreRuntime = (
  { context, request }: Rspack.ExternalItemFunctionData,
  resolveExternal: (error?: Error, external?: string) => void,
): void => {
  if (request === undefined || context === undefined) {
    resolveExternal();
    return;
  }
  if (/^@app\/core-runtime(?:\/|$)/u.test(request)) {
    resolveExternal(undefined, `module-import ${request}`);
    return;
  }
  const resolved = request.startsWith('.') ? path.resolve(context, request) : undefined;
  if (resolved !== undefined && resolved.startsWith(coreRuntimeRoot)) {
    resolveExternal(undefined, `module-import ${pathToFileURL(resolved).href}`);
    return;
  }
  resolveExternal();
};

// SWC rejects every generic arrow function in the imported `scripts/**/*.mts` files (even
// `<T,>(...)`) under its default mts/cts parser mode. The parser key is missing from the
// bundled swc types, so the object is declared here instead of inline.
const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

export default defineConfig({
  projects: [
    {
      clearMocks: true,
      extends: withModernConfig({
        configPath: './modern.rstest.config.ts',
      }),
      include: ['tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
      name: 'unit',
      output: {
        module: false,
      },
      restoreMocks: true,
      source: {
        define: {
          ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: encodedReferenceTopology,
          ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: encodedModuleDeploymentAllowlist,
          ULTRAMODERN_SITE_URL: encodedSiteUrl,
        },
      },
      testEnvironment: 'happy-dom',
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { rspack: { externals: [externalizeCoreRuntime] }, swc },
    },
  ],
});
