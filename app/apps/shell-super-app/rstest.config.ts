import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';
import type { Rspack } from '@rstest/core';
import { Result, Schema } from 'effect';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

const encodedSiteUrl = Result.getOrThrow(
  Schema.encodeResult(Schema.fromJsonString(Schema.String))('http://localhost:3020'),
);

// Better Auth's ESM graph uses top-level await; keep it native instead of lowering it into
// the CommonJS unit bundle (Rspack otherwise emits invalid async dependency wrappers).
const externalizeRuntimeDependencies = (
  { request }: Rspack.ExternalItemFunctionData,
  resolveExternal: (error?: Error, external?: string) => void,
): void => {
  if (request === 'cloudflare:workers' || request?.endsWith('/fixtures/worker-environment.ts') === true) {
    resolveExternal(
      undefined,
      `module-import ${new URL('tests/fixtures/worker-environment.ts', import.meta.url).href}`,
    );
    return;
  }
  resolveExternal(
    undefined,
    request !== undefined && /^(?:@better-auth\/|better-auth(?:\/|$))/u.test(request)
      ? `module-import ${pathToFileURL(createRequire(import.meta.url).resolve(request)).href}`
      : undefined,
  );
};

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
    resolveExternal(undefined, `module-import ${pathToFileURL(createRequire(import.meta.url).resolve(request)).href}`);
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
  output: { distPath: path.join(tmpdir(), `ontos-shell-rstest-${process.pid}`) },
  performance: { buildCache: false },
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
      plugins: [
        {
          name: 'ontos:unit-without-ssr-compilation',
          remove: ['@modern-js/builder-plugin-ssr'],
          setup() {
            // This plugin only removes SSR compilation from browser lifecycle tests.
          },
        },
      ],
      restoreMocks: true,
      source: {
        define: {
          __ONTOS_BROWSER_BUILD__: 'true',
          ULTRAMODERN_SITE_URL: encodedSiteUrl,
        },
      },
      testEnvironment: 'happy-dom',
      tools: { rspack: { externals: [externalizeRuntimeDependencies] } },
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      source: {
        define: {
          ULTRAMODERN_SITE_URL: encodedSiteUrl,
        },
      },
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { rspack: { externals: [externalizeRuntimeDependencies, externalizeCoreRuntime] }, swc },
    },
  ],
});
