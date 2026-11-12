import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { build } from 'esbuild';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import {
  coreRuntimeValueReExports,
  focusedEntrypointValueExports,
  makeProductionDependenciesPlugin,
} from '../materialize-outbox-worker.mjs';

const WORKER_ENTRY_SPECIFIER = '@app/core-runtime/outbox/worker';
const workerEntrypointPath = '../../packages/core-runtime/src/outbox/worker-entrypoint.ts';

it('reads live value re-exports from Core, ignoring comments, strings, and type-only ones', () => {
  const source = [
    "export { ContextAccessLive as outboxWorkerContextAccessLive } from '@app/core-runtime';",
    "export { type OutboxRuntime, BusinessPermissionRelationshipMutationLive } from '@app/core-runtime';",
    "export type { AnyOutboxWorkerRegistration } from '@app/core-runtime';",
    'export { defineOutboxWorkerCompletion as completion } from WORKER_ENTRY_SPECIFIER;',
    "// export { RemovedBinding } from '@app/core-runtime';",
    "/* export { AlsoRemoved } from '@app/core-runtime'; */",
    "console.log(`export { FromString } from '@app/core-runtime'`);",
    "export { other } from '@app/core-runtime/testing/actions';",
    "export { local } from './local.ts';",
  ].join('\n');
  expect(EffectArray.sort(coreRuntimeValueReExports('layer.ts', source), Order.String)).toEqual([
    'BusinessPermissionRelationshipMutationLive',
    'ContextAccessLive',
    'defineOutboxWorkerCompletion',
  ]);
});

it('reads only live value exports of the focused entrypoint', () => {
  const exports = focusedEntrypointValueExports(
    [
      "export { Live, Other as Renamed } from './live.ts';",
      "// export { CommentedOut } from './gone.ts';",
      "export { type OnlyType } from './types.ts';",
      "export type { AlsoType } from './types.ts';",
    ].join('\n'),
  );
  expect(EffectArray.sort([...exports], Order.String)).toEqual(['Live', 'Renamed']);
});

it('routes hosted worker enrollment through the focused Core worker entrypoint, never a Core db/ subpath', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  const workerRoots = [
    'apps/shell-super-app/src/entry.core-system-worker.ts',
    ...['commerce-customer-context', 'privacy', 'finance-billing', 'inventory'].map(
      (owner) => `verticals/${owner}/src/worker-host/entry.ts`,
    ),
    ...[
      'crm',
      'facility-operations',
      'legal-agreements',
      'property-leasing',
      'property-portfolio',
      'sales-pipeline',
      'work-tasks',
    ].map((owner) => `verticals/${owner}/src/worker-host/layer.ts`),
  ];
  const enrollmentImports: string[] = [];
  for (const filename of workerRoots) {
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf-8');
    const imports = parseSync(filename, source).module.staticImports.flatMap((statement) =>
      statement.entries
        .filter((entry) => !entry.isType)
        .map((entry) => ({ name: entry.importName.name, specifier: statement.moduleRequest.value })),
    );
    const declarations = imports
      .filter(({ name }) => name === 'defineDatabaseIdentityEnrollment')
      .map(({ specifier }) => specifier);
    enrollmentImports.push(...declarations);
    for (const specifier of declarations) {
      expect(specifier, filename).toBe(WORKER_ENTRY_SPECIFIER);
    }
    for (const { name, specifier } of imports) {
      if (specifier === '@app/core-runtime' || specifier === WORKER_ENTRY_SPECIFIER) {
        expect(entrypoint.has(name ?? ''), `${filename} imports ${name} from ${specifier}`).toBe(true);
      }
    }
  }
  expect(enrollmentImports.length).toBeGreaterThan(0);
  expect(entrypoint.has('makeDatabaseIdentityEnrollmentLive')).toBe(true);
  expect(entrypoint.has('CoreSearchQueryRuntime')).toBe(true);
  expect(entrypoint.has('CoreSearchProjectionInvalid')).toBe(true);
  expect(entrypoint.has('defineDatabaseIdentityEnrollment')).toBe(true);
});

it('exports every Core value the deployed worker hosts re-export', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  const layerPath = '../../verticals/commerce-customer-context/src/worker-host/layer.ts';
  const reExports = coreRuntimeValueReExports('layer.ts', readFileSync(new URL(layerPath, import.meta.url), 'utf-8'));
  // The fixture re-exports the Core values its worker handlers need; the guard keeps it non-trivial.
  expect(reExports).toContain('CorePersistenceLive');
  for (const name of reExports) {
    expect(entrypoint.has(name), name).toBe(true);
  }
  expect(entrypoint.has('AnyOutboxWorkerRegistration')).toBe(false);
});

const WorkerPackageSchema = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    exports: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ './outbox-worker-host': Schema.optionalKey(Schema.String) }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
    name: Schema.String,
  }),
);

it.live('bundles every deployed worker with the original production dependency resolver', () =>
  Effect.gen(function* actualHostedWorkerBundle() {
    const workspaceRoot = path.resolve(import.meta.dirname, '../..');
    const fs = yield* FileSystem.FileSystem;
    const nativePath = yield* Path.Path;
    const packages: Parameters<typeof makeProductionDependenciesPlugin>[0]['packages'] = new Map();
    const workerHostEntries = new Map<string, string>();
    for (const directory of ['packages', 'apps', 'verticals']) {
      const parent = path.join(workspaceRoot, directory);
      for (const entry of yield* fs.readDirectory(parent)) {
        const manifestFile = path.join(parent, entry, 'package.json');
        if (yield* fs.exists(manifestFile)) {
          const manifest = yield* Schema.decodeUnknownEffect(WorkerPackageSchema)(
            yield* fs.readFileString(manifestFile),
          );
          const { exports: packageExports, ...packageManifest } = manifest;
          packages.set(manifest.name, { manifest: packageManifest });
          const workerHost = packageExports?.['./outbox-worker-host'];
          if (workerHost !== undefined) {
            workerHostEntries.set(`${manifest.name}/outbox-worker-host`, path.posix.join(directory, entry, workerHost));
          }
        }
      }
    }
    const hostSource = yield* fs.readFileString(path.join(workspaceRoot, 'scripts/outbox-worker-host.generated.mts'));
    const deployedEntries = parseSync('outbox-worker-host.generated.mts', hostSource)
      .module.staticImports.map((statement) => statement.moduleRequest.value)
      .filter((specifier) => specifier.endsWith('/outbox-worker-host'));
    // The generated host is the deployed discovery result; it must enroll many owners, each with a real entry file.
    expect(deployedEntries.length).toBeGreaterThan(10);
    const result = yield* Effect.promise(() =>
      build({
        absWorkingDir: workspaceRoot,
        bundle: true,
        entryPoints: ['scripts/outbox-worker-host.generated.mts'],
        format: 'esm',
        logLevel: 'silent',
        metafile: true,
        platform: 'node',
        plugins: [makeProductionDependenciesPlugin({ packages, path: nativePath, workspaceRoot })],
        target: 'node26',
        write: false,
      }),
    );
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContain('packages/core-runtime/src/outbox/worker-entrypoint.ts');
    for (const specifier of deployedEntries) {
      expect(inputs, specifier).toContain(workerHostEntries.get(specifier));
    }
    expect(inputs.filter((file) => /\.(?:tsx|css)$/u.test(file))).toEqual([]);
    const entrypoint = focusedEntrypointValueExports(
      yield* fs.readFileString(path.join(workspaceRoot, 'packages/core-runtime/src/outbox/worker-entrypoint.ts')),
    );
    expect(entrypoint.has('defineDatabaseIdentityEnrollment')).toBe(true);
    const enrollmentSpecifiers: string[] = [];
    for (const input of inputs.filter((file) => /^(?:apps|verticals)\/.*\.(?:ts|mts)$/u.test(file))) {
      const source = yield* fs.readFileString(path.join(workspaceRoot, input));
      // The materializer's own guard: a re-exported Core name absent from the facade would bundle as undefined.
      for (const name of coreRuntimeValueReExports(input, source)) {
        expect(entrypoint.has(name), `${input} re-exports ${name}`).toBe(true);
      }
      for (const statement of parseSync(input, source).module.staticImports) {
        if (
          statement.entries.some(
            (entry) => !entry.isType && entry.importName.name === 'defineDatabaseIdentityEnrollment',
          )
        ) {
          enrollmentSpecifiers.push(`${input} ${statement.moduleRequest.value}`);
          expect(statement.moduleRequest.value, input).toBe(WORKER_ENTRY_SPECIFIER);
        }
      }
    }
    expect(enrollmentSpecifiers.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it('exports the Core values used by the hosted search snapshot projectors', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL(workerEntrypointPath, import.meta.url), 'utf-8'),
  );
  for (const owner of ['sales-pipeline', 'work-tasks']) {
    const filename = `verticals/${owner}/src/services/search-projection.ts`;
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf-8');
    const imports = parseSync(filename, source).module.staticImports.flatMap((statement) =>
      statement.moduleRequest.value === '@app/core-runtime'
        ? statement.entries.filter((entry) => !entry.isType).map((entry) => entry.importName.name ?? '')
        : [],
    );
    expect(imports, filename).toContain('CoreSearchProjectionReplacementSchema');
    for (const name of imports) {
      expect(entrypoint.has(name), `${filename} imports ${name} from the focused worker entrypoint`).toBe(true);
    }
  }
});
