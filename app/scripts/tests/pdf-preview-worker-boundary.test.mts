import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const owner = path.join(workspace, 'verticals/facility-operations');
const preview = path.join(owner, 'src/ui/pdf-preview.tsx');
const browserBoundary = "if (import.meta.env.MODERN_TARGET === 'browser') {";
const unsafeImportMessage = 'Cloudflare worker bundles must not contain non-static dynamic module imports.';
const Compilation = Schema.fromJsonString(
  Schema.Struct({
    hasRenderer: Schema.Boolean,
    hasWorker: Schema.Boolean,
    issues: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);

// Compile the real component with the installed Rspack and run the unchanged native closure verifier.
// UI dependencies are explicit external fixture inputs; both PDF.js modules must actually be bundled.
const driver = `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const [entry, directory, target, owner] = process.argv.slice(1);
const appTools = require.resolve('@modern-js/app-tools-extensions/config');
const rsbuild = require.resolve('@rsbuild/core', { paths: [appTools] });
const { rspack, DefinePlugin } = require(require.resolve('@rspack/core', { paths: [rsbuild] }));
const { verifyWorkerBundleReferences } = require(
  require.resolve('@modern-js/app-tools-extensions/cloudflare-output-verifier/worker-bundles'));
const compiler = rspack({
  context: owner,
  devtool: false,
  entry,
  experiments: { outputModule: true },
  externals: {
    '@modern-js/plugin-i18n/runtime': '@modern-js/plugin-i18n/runtime',
    '@techsio/ui-kit/atoms/button': '@techsio/ui-kit/atoms/button',
    effect: 'effect',
    react: 'react',
    'react/jsx-runtime': 'react/jsx-runtime',
  },
  externalsType: 'module',
  mode: 'production',
  module: {
    parser: { javascript: { dynamicImportMode: 'eager' } },
    rules: [{
      test: /\\.tsx?$/u,
      use: {
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            target: 'es2022',
            transform: { react: { runtime: 'automatic' } },
          },
        },
      },
    }],
  },
  optimization: { concatenateModules: false, minimize: false, moduleIds: 'named' },
  output: { filename: 'preview.mjs', library: { type: 'module' }, module: true, path: directory },
  plugins: [new DefinePlugin({ 'import.meta.env.MODERN_TARGET': JSON.stringify(target) })],
  resolve: {
    alias: {
      '../runtime/browser-effect-runtime.ts': path.join(owner, 'src/runtime/browser-effect-runtime.ts'),
      './pdf-render-lifecycle.ts': path.join(owner, 'src/ui/pdf-render-lifecycle.ts'),
    },
    extensions: ['.tsx', '.ts', '.js', '.mjs'],
    modules: [path.join(owner, 'node_modules'), 'node_modules'],
  },
  target: 'webworker',
});
try {
  const stats = await promisify(compiler.run.bind(compiler))();
  if (!stats || stats.hasErrors()) throw new Error(stats?.toString({ all: false, errors: true }) ?? 'Missing stats');
  const modules = stats.toJson({ all: false, modules: true }).modules ?? [];
  const filename = path.join(directory, 'preview.mjs');
  const source = await readFile(filename, 'utf-8');
  const issues = [];
  await verifyWorkerBundleReferences(
    issues,
    { kind: 'route', path: filename, reference: 'preview.mjs' },
    source,
    { providedPackages: new Set(['@modern-js/plugin-i18n', '@techsio/ui-kit', 'effect', 'react']), workerRoot: directory },
  );
  process.stdout.write(JSON.stringify({
    hasRenderer: modules.some(module => module.name?.includes('pdfjs-dist/build/pdf.mjs')),
    hasWorker: modules.some(module => module.name?.includes('pdfjs-dist/build/pdf.worker.mjs')),
    issues,
  }));
} finally {
  await promisify(compiler.close.bind(compiler))();
}
`;

const compilePreview = Effect.fn(function* compilePreview(target: string, removeBoundary: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-pdf-preview-boundary-' });
  const source = yield* fs.readFileString(preview);
  expect(source.split(browserBoundary)).toHaveLength(2);
  const entry = removeBoundary ? path.join(directory, 'unguarded-preview.tsx') : preview;
  if (removeBoundary) {
    yield* fs.writeFileString(entry, source.replace(browserBoundary, 'if (true) {'));
  }
  const result = yield* collectToolingProcess(
    ChildProcess.make(process.execPath, ['--input-type=module', '--eval', driver, entry, directory, target, owner], {
      cwd: workspace,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  );
  expect(result.status, result.stderr).toBe(0);
  return yield* Schema.decodeUnknownEffect(Compilation)(result.stdout);
});

it.live(
  'the actual PDF preview excludes PDF.js from workerSSR and passes the native Worker verifier',
  Effect.fn(
    function* workerBoundary() {
      const result = yield* compilePreview('node', false);
      expect(result.hasRenderer).toBe(false);
      expect(result.hasWorker).toBe(false);
      expect(result.issues).toEqual([]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'the browser build retains the real PDF renderer and in-page parser',
  Effect.fn(
    function* browserPreview() {
      const result = yield* compilePreview('browser', false);
      expect(result.hasRenderer).toBe(true);
      expect(result.hasWorker).toBe(true);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'removing the boundary reproduces the native non-static-import rejection',
  Effect.fn(
    function* unguardedControl() {
      const result = yield* compilePreview('node', true);
      expect(result.hasRenderer).toBe(true);
      expect(result.hasWorker).toBe(true);
      // The native verifier reports the condition once per visited bundle, not once per import.
      expect(result.issues).toHaveLength(1);
      expect(result.issues).toContainEqual({
        code: 'invalid-worker-bundle',
        message: unsafeImportMessage,
      });
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
