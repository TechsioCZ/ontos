import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { CodeSmith, GeneratorCore } from '@modern-js/codesmith';
import { Cause, Effect, Fiber, FileSystem, Schema } from 'effect';
import { afterEach, expect, it, rs } from 'effect-rstest';

import { getHelpText, runScaffoldEffect, ScaffoldingError } from '../cli.mts';
import { applyMutationPlanEffect } from '../shared.mts';
import { snapshotTree, write } from './fixture-files.mts';
import { linkFixtureDependencies, withCreatedFixture } from './fixture-ownership.mts';

afterEach(() => {
  rs.restoreAllMocks();
});

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');
const verticalName = 'property-registry';
const moduleId = 'property.registry';
const resourceName = 'rental-unit';
const verticalFlag = '--vertical';
const resourceType = `${moduleId}.${resourceName}`;
const tenantId = '00000000-0000-4000-8000-000000000001';
const verticalRoot = `verticals/${verticalName}`;
const verticalPackagePath = `${verticalRoot}/package.json`;
const verticalManifestPath = `${verticalRoot}/vertical.manifest.ts`;
const packageJsonSchema = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.String),
});
const generatedResourceModuleSchema = Schema.Struct({
  RentalUnitRefSchema: Schema.declare<Schema.Top>(Schema.isSchema),
});

type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

const createFixture = (): Effect.Effect<string, unknown> =>
  Effect.gen(function* mergedScenario9() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-resource-scaffold-')));
    yield* write(root, 'package.json', json({ name: 'fixture', private: true, type: 'module' }));
    yield* write(
      root,
      verticalPackagePath,
      json({
        dependencies: { effect: '4.0.0-beta.107' },
        exports: { '.': './src/index.ts' },
        modernjs: {
          apiRuntime: 'effect',
          appId: verticalName,
          preset: 'presetUltramodern',
          role: 'module-federation-remote',
          topology: '../../topology/reference-topology.json',
        },
        name: '@app/property-registry',
        private: true,
        scripts: {
          build: 'modern build && MODERNJS_DEPLOY=node modern deploy --skip-build',
          'cloudflare:build':
            'MODERNJS_DEPLOY=cloudflare modern build && MODERNJS_DEPLOY=cloudflare modern deploy --skip-build',
        },
        type: 'module',
        version: '0.1.0',
      }),
    );
    yield* write(
      root,
      'verticals/property-registry/tsconfig.json',
      json({
        compilerOptions: { composite: true },
        include: ['src', 'shared'],
        references: [],
      }),
    );
    yield* write(root, 'verticals/property-registry/module-federation.config.ts', 'export default { exposes: {} };\n');
    yield* write(
      root,
      'verticals/property-registry/shared/api.ts',
      `import { HttpApi } from 'effect/unstable/httpapi';

export const propertyRegistryApi = HttpApi.make('PropertyRegistryApi');
`,
    );
    yield* write(
      root,
      'verticals/property-registry/api/index.ts',
      `import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectRuntimeLayer } from '@modern-js/bff-effect/effect-edge';
import { propertyRegistryApi } from '../shared/api.ts';

const layer = HttpApiBuilder.layer(propertyRegistryApi).pipe(
  Layer.provide(Layer.empty),
) satisfies EffectRuntimeLayer;

export default defineEffectBff({ api: propertyRegistryApi, layer });
`,
    );
    yield* write(
      root,
      'topology/reference-topology.json',
      json({
        schemaVersion: 1,
        verticals: [
          {
            domain: 'property',
            id: verticalName,
            kind: 'vertical',
            moduleFederation: {
              name: 'verticalPropertyRegistry',
              role: 'remote',
            },
            package: '@app/property-registry',
            path: 'verticals/property-registry',
          },
        ],
      }),
    );
    yield* write(
      root,
      'types/core-runtime.d.ts',
      `import type { Schema } from 'effect';

export interface OntosResourceType {
  readonly capabilities: {
    readonly graphVisible: boolean;
    readonly linkable: boolean;
    readonly mediaAttachable: boolean;
    readonly searchable: boolean;
    readonly timelineVisible: boolean;
  };
  readonly description: string;
  readonly key: string;
  readonly label: string;
  readonly owningModuleId: string;
}

export declare const defineOntosModuleManifest: <const Value>(value: Value) => Readonly<Value>;
export declare const ShellNavigationContributionSchema: Schema.Codec<unknown, unknown>;
export declare const ShellPageContributionSchema: Schema.Codec<unknown, unknown>;
export declare const ShellPublicComponentContributionSchema: Schema.Codec<unknown, unknown>;
export declare const ShellReportContributionSchema: Schema.Codec<unknown, unknown>;
export declare const ShellSearchContributionSchema: Schema.Codec<unknown, unknown>;
`,
    );
    yield* linkFixtureDependencies(root, appRoot, {
      '@app/core-runtime': 'packages/core-runtime',
      effect: 'node_modules/effect',
    });
    yield* runScaffoldEffect('module-contract', [verticalFlag, verticalName, '--module', moduleId], {
      workspaceRoot: root,
    }).pipe(Effect.provide(NodeServices.layer));
    return root;
  });

const withFixture = withCreatedFixture(createFixture());

const scaffoldResource = Effect.fn(function* scenario7(root: string, resource = resourceName) {
  return yield* runScaffoldEffect('resource', [verticalFlag, verticalName, '--resource', resource], {
    workspaceRoot: root,
  }).pipe(Effect.provide(NodeServices.layer));
});

/** Refusal must preserve the fixture byte-for-byte. */
const assertResourceScaffoldRefused = Effect.fn(function* assertResourceScaffoldRefused(
  root: string,
  expected: RegExp,
  ignored: readonly string[] = ['node_modules'],
) {
  const before = yield* snapshotTree(root, ignored);
  const cause = yield* scaffoldResource(root).pipe(Effect.sandbox, Effect.flip);
  expect(String(Cause.squash(cause))).toMatch(expected);
  expect(yield* snapshotTree(root, ignored)).toEqual(before);
});

it.live(
  'resource help documents the public command and writes nothing',
  Effect.fn(function* scenario8() {
    const missingRoot = path.join(tmpdir(), 'resource-help-does-not-exist');
    const result = yield* runScaffoldEffect('resource', ['--help'], {
      workspaceRoot: missingRoot,
    }).pipe(Effect.provide(NodeServices.layer));
    expect(result).toEqual({ help: getHelpText('resource'), kind: 'help' });
    if (result.kind !== 'help') {
      throw new Error('Expected help result');
    }
    expect(result.help).toMatch(/scaffold:resource -- --vertical <vertical> --resource <resource>/u);
    expect(result.help).toMatch(/lower-kebab-case/u);
  }),
);

it.live(
  'resource scaffold publishes a typed ResourceRef and registers its descriptor',
  Effect.fn(function* scenario9() {
    yield* withFixture(
      Effect.fn(function* scenario10(root) {
        const result = yield* scaffoldResource(root);
        expect(result.kind).toBe('generated');

        const resourcePath = path.join(root, 'verticals/property-registry/shared/resources/rental-unit.ts');
        const [resource, manifest, packageSource] = yield* Effect.all(
          [
            Effect.promise(() => readFile(resourcePath, 'utf-8')),
            Effect.promise(() => readFile(path.join(root, verticalManifestPath), 'utf-8')),
            Effect.promise(() => readFile(path.join(root, verticalPackagePath), 'utf-8')),
          ],
          { concurrency: 'unbounded' },
        );
        expect(resource).toMatch(/import type \{ OntosResourceType \} from '@app\/core-runtime';/u);
        expect(resource).toMatch(/import \{ Schema \} from 'effect';/u);
        expect(resource).toMatch(/export const RentalUnitRefSchema = Schema\.Struct/u);
        expect(resource).toMatch(/Schema\.isMaxLength\(300\)/u);
        expect(resource).toMatch(/const TenantIdSchema = Schema\.String\.check\(Schema\.isUUID\(\)\)/u);
        expect(resource).toMatch(/moduleId: Schema\.Literal\('property\.registry'\)/u);
        expect(resource).toMatch(/resourceType: Schema\.Literal\('property\.registry\.rental-unit'\)/u);
        expect(resource).toMatch(/resourceId: ResourceIdSchema/u);
        expect(resource).toMatch(/tenantId: TenantIdSchema/u);
        expect(resource).toMatch(/export type RentalUnitRef = typeof RentalUnitRefSchema\.Type;/u);
        expect(resource).toMatch(
          /export const rentalUnitResourceDescriptor = \{[\s\S]*key: 'property\.registry\.rental-unit'/u,
        );
        expect(resource).toMatch(/satisfies OntosResourceType/u);

        expect(manifest).toMatch(
          /import \{ rentalUnitResourceDescriptor \} from '\.\/shared\/resources\/rental-unit\.ts';/u,
        );
        expect(manifest).toMatch(/resourceTypes: \[[\s\S]*rentalUnitResourceDescriptor,/u);
        const modulePackage = yield* Schema.decodeUnknownEffect(packageJsonSchema, {
          onExcessProperty: 'preserve',
        })(JSON.parse(packageSource));
        expect(modulePackage.exports['./resources/rental-unit']).toBe('./shared/resources/rental-unit.ts');

        const generatedModule = yield* Schema.decodeUnknownEffect(generatedResourceModuleSchema)(
          yield* Effect.promise(() => import(`${pathToFileURL(resourcePath).href}?test=${randomUUID()}`)),
        );
        const rentalUnitRefSchema = Schema.make<Schema.Codec<unknown, unknown>>(
          generatedModule.RentalUnitRefSchema.ast,
        );
        const reference = yield* Schema.decodeUnknownEffect(rentalUnitRefSchema)({
          moduleId,
          resourceId: 'unit-42',
          resourceType,
          tenantId,
        });
        expect(reference).toEqual({
          moduleId,
          resourceId: 'unit-42',
          resourceType,
          tenantId,
        });
        const invalidReference = yield* Schema.decodeUnknownEffect(rentalUnitRefSchema)({
          moduleId,
          resourceId: '',
          resourceType,
          tenantId,
        }).pipe(Effect.flip);
        expect(String(invalidReference)).toMatch(/length of at least 1/u);

        const fixtureTsconfig = path.join(root, 'tsconfig.generated.json');
        yield* write(
          root,
          'tsconfig.generated.json',
          json({
            compilerOptions: {
              allowImportingTsExtensions: true,
              module: 'preserve',
              moduleResolution: 'Bundler',
              noEmit: true,
              paths: {
                '@app/core-runtime': ['./types/core-runtime.d.ts'],
              },
              skipLibCheck: true,
              strict: true,
              target: 'ESNext',
            },
            include: ['verticals/property-registry/shared/resources/**/*.ts', verticalManifestPath],
          }),
        );
        const compilation = spawnSync(tscPath, ['-p', fixtureTsconfig], {
          cwd: root,
          encoding: 'utf-8',
        });
        expect(compilation.status, `${compilation.stdout}${compilation.stderr}`).toBe(0);
      }),
    );
  }),
);

it.live(
  'resource scaffold rejects traversal and reruns without partial writes',
  Effect.fn(function* scenario11() {
    yield* withFixture(
      Effect.fn(function* scenario12(root) {
        const beforeTraversal = yield* snapshotTree(root, ['node_modules']);
        const failureCause1 = yield* Effect.flip(Effect.sandbox(scaffoldResource(root, '../unsafe')));
        expect(String(Cause.squash(failureCause1))).toMatch(/lower-kebab-case/u);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(beforeTraversal);

        yield* scaffoldResource(root);
        yield* assertResourceScaffoldRefused(root, /refusing to overwrite existing business file/u);
      }),
    );
  }),
);

it.live(
  'resource scaffold leaves no artifact when generated owner slots or exports are invalid',
  Effect.fn(function* scenario13() {
    yield* withFixture(
      Effect.fn(function* scenario14(root) {
        const manifestPath = path.join(root, verticalManifestPath);
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            manifest.replace('// <generated-module-manifest-resources>', '// invalid-resource-slot'),
            'utf-8',
          ),
        );
        yield* assertResourceScaffoldRefused(root, /generated owner file/u);
      }),
    );

    yield* withFixture(
      Effect.fn(function* scenario15(root) {
        const packagePath = path.join(root, verticalPackagePath);
        const packageValue = yield* Schema.decodeUnknownEffect(packageJsonSchema, {
          onExcessProperty: 'preserve',
        })(JSON.parse(yield* Effect.promise(() => readFile(packagePath, 'utf-8'))));
        const packageWithExportCollision = {
          ...packageValue,
          exports: {
            ...packageValue.exports,
            './resources/rental-unit': './someone-elses-contract.ts',
          },
        };
        yield* Effect.promise(() => writeFile(packagePath, json(packageWithExportCollision), 'utf-8'));
        yield* assertResourceScaffoldRefused(root, /resource contract export .* already exists/u);
      }),
    );
  }),
);

it.live(
  'resource scaffold rejects a manifest without the governed resource slot',
  Effect.fn(function* mergedScenario12() {
    yield* withFixture(
      Effect.fn(function* mergedScenario11(root) {
        const manifestPath = path.join(root, verticalManifestPath);
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            manifest.replace(
              `    resourceTypes: [
      // <generated-module-manifest-resources>
      // </generated-module-manifest-resources>
    ],`,
              '    resourceTypes: [],',
            ),
            'utf-8',
          ),
        );

        yield* assertResourceScaffoldRefused(root, /slot/u, []);
      }),
    );
  }),
);

it.live(
  'waits for an interrupted Codesmith write before removing its scoped output',
  Effect.fn(function* scenario18() {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-scaffold-cancellation-'))),
      (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true })),
    );
    const smith = new CodeSmith({ namespace: 'ontos-scaffolding-test' });
    const core = new GeneratorCore({
      logger: smith.logger,
      materialsManager: smith.materialsManager,
      outputPath: root,
    });
    const started = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const events: string[] = [];
    rs.spyOn(core.output, 'fs').mockImplementation(async () => {
      started.resolve(null);
      // Codesmith owns this Promise-returning output callback.
      await release.promise;
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'generated.ts'), 'export {};');
      events.push('write');
    });
    const recordCleanup = () => events.push('cleanup');
    yield* Effect.gen(function* verifyWriteCleanupOrder() {
      const fileSystem = yield* FileSystem.FileSystem;
      const worker = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* writeScopedOutput() {
            yield* Effect.addFinalizer(() =>
              fileSystem
                .remove(root, { force: true, recursive: true })
                .pipe(Effect.orDie, Effect.andThen(Effect.sync(recordCleanup))),
            );
            yield* applyMutationPlanEffect(core, {
              mutations: [
                {
                  content: 'export {};',
                  kind: 'create',
                  path: path.join(root, 'generated.ts'),
                },
              ],
              result: null,
            });
          }),
        ),
      );
      yield* Effect.promise(() => started.promise);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(worker));
      yield* Effect.yieldNow;
      expect(events).toEqual([]);
      release.resolve(null);
      yield* Fiber.join(interruption);
      expect(events).toEqual(['write', 'cleanup']);
      expect(yield* fileSystem.exists(root)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer));
  }),
);

it.live(
  'reports synchronous malformed-owner validation through the typed command channel',
  Effect.fn(function* scenario19() {
    yield* withFixture(
      Effect.fn(function* scenario20(root) {
        yield* Effect.promise(() => writeFile(path.join(root, verticalPackagePath), '[]'));
        const before = yield* snapshotTree(root, ['node_modules']);
        const failure = yield* runScaffoldEffect('resource', [verticalFlag, verticalName, '--resource', resourceName], {
          workspaceRoot: root,
        }).pipe(Effect.flip, Effect.provide(NodeServices.layer));
        expect(Schema.is(ScaffoldingError)(failure)).toBe(true);
        expect(failure.message).toMatch(/JSON object/u);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
      }),
    );
  }),
);
