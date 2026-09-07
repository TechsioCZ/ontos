import { runEffectTestPromise } from '../../../packages/core-runtime/src/testing/effect-runtime.ts';
import { Effect, Fiber, FileSystem, Schema } from 'effect';
import { CodeSmith, GeneratorCore } from '@modern-js/codesmith';
import { applyMutationPlanEffect } from '../shared.mts';
import { NodeServices } from '@effect/platform-node';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { getHelpText, runScaffoldEffect, ScaffoldingError } from '../cli.mts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');
const verticalName = 'property-registry';
const moduleId = 'property.registry';
const resourceName = 'rental-unit';
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

type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

const write = async (root: string, relativePath: string, content: string): Promise<void> => {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
};

const snapshotTree = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          await visit(entryPath);
        } else if (entry.isFile()) {
          snapshot[path.relative(root, entryPath)] = await readFile(entryPath, 'utf-8');
        }
      }),
    );
  };
  await visit(root);
  return snapshot;
};

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-resource-scaffold-'));
  await write(root, 'package.json', json({ name: 'fixture', private: true, type: 'module' }));
  await write(
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
  await write(
    root,
    'verticals/property-registry/tsconfig.json',
    json({
      compilerOptions: { composite: true },
      include: ['src', 'shared'],
      references: [],
    }),
  );
  await write(
    root,
    'verticals/property-registry/module-federation.config.ts',
    'export default { exposes: {} };\n',
  );
  await write(
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
  await write(
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
  await mkdir(path.join(root, 'node_modules', '@app'), { recursive: true });
  await symlink(
    path.join(appRoot, 'packages/core-runtime'),
    path.join(root, 'node_modules/@app/core-runtime'),
    'dir',
  );
  await symlink(path.join(appRoot, 'node_modules/effect'), path.join(root, 'node_modules/effect'));
  await runEffectTestPromise(
    runScaffoldEffect('module-contract', ['--vertical', verticalName, '--module', moduleId], {
      workspaceRoot: root,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return root;
};

const withFixture = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await createFixture();
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const scaffoldResource = async (root: string, resource = resourceName) =>
  await runEffectTestPromise(
    runScaffoldEffect('resource', ['--vertical', verticalName, '--resource', resource], {
      workspaceRoot: root,
    }).pipe(Effect.provide(NodeServices.layer)),
  );

await test('resource help documents the public command and writes nothing', async () => {
  const missingRoot = path.join(tmpdir(), 'resource-help-does-not-exist');
  const result = await runEffectTestPromise(
    runScaffoldEffect('resource', ['--help'], {
      workspaceRoot: missingRoot,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.deepEqual(result, { help: getHelpText('resource'), kind: 'help' });
  assert.match(result.help, /scaffold:resource -- --vertical <vertical> --resource <resource>/u);
  assert.match(result.help, /lower-kebab-case/u);
});

await test('resource scaffold publishes a typed ResourceRef and registers its descriptor', async () => {
  await withFixture(async (root) => {
    const result = await scaffoldResource(root);
    assert.equal(result.kind, 'generated');

    const resourcePath = path.join(
      root,
      'verticals/property-registry/shared/resources/rental-unit.ts',
    );
    const [resource, manifest, packageSource] = await Promise.all([
      readFile(resourcePath, 'utf-8'),
      readFile(path.join(root, verticalManifestPath), 'utf-8'),
      readFile(path.join(root, verticalPackagePath), 'utf-8'),
    ]);
    assert.match(resource, /import type \{ OntosResourceType \} from '@app\/core-runtime';/u);
    assert.match(resource, /import \{ Schema \} from 'effect';/u);
    assert.match(resource, /export const RentalUnitRefSchema = Schema\.Struct/u);
    assert.match(resource, /Schema\.isMaxLength\(300\)/u);
    assert.match(resource, /const TenantIdSchema = Schema\.String\.check\(Schema\.isUUID\(\)\)/u);
    assert.match(resource, /moduleId: Schema\.Literal\('property\.registry'\)/u);
    assert.match(resource, /resourceType: Schema\.Literal\('property\.registry\.rental-unit'\)/u);
    assert.match(resource, /resourceId: ResourceIdSchema/u);
    assert.match(resource, /tenantId: TenantIdSchema/u);
    assert.match(resource, /export type RentalUnitRef = typeof RentalUnitRefSchema\.Type;/u);
    assert.match(
      resource,
      /export const rentalUnitResourceDescriptor = \{[\s\S]*key: 'property\.registry\.rental-unit'/u,
    );
    assert.match(resource, /satisfies OntosResourceType/u);

    assert.match(
      manifest,
      /import \{ rentalUnitResourceDescriptor \} from '\.\/shared\/resources\/rental-unit\.ts';/u,
    );
    assert.match(manifest, /resourceTypes: \[[\s\S]*rentalUnitResourceDescriptor,/u);
    const modulePackage = Schema.decodeUnknownSync(packageJsonSchema, {
      onExcessProperty: 'preserve',
    })(JSON.parse(packageSource));
    assert.equal(
      modulePackage.exports['./resources/rental-unit'],
      './shared/resources/rental-unit.ts',
    );

    const generatedModule = Schema.decodeUnknownSync(generatedResourceModuleSchema)(
      await import(`${pathToFileURL(resourcePath).href}?test=${randomUUID()}`),
    );
    const rentalUnitRefSchema = Schema.make<Schema.Codec<unknown, unknown>>(
      generatedModule.RentalUnitRefSchema.ast,
    );
    const reference = Schema.decodeUnknownSync(rentalUnitRefSchema)({
      moduleId,
      resourceId: 'unit-42',
      resourceType,
      tenantId,
    });
    assert.deepEqual(reference, {
      moduleId,
      resourceId: 'unit-42',
      resourceType,
      tenantId,
    });
    assert.throws(
      () =>
        Schema.decodeUnknownSync(rentalUnitRefSchema)({
          moduleId,
          resourceId: '',
          resourceType,
          tenantId,
        }),
      /length of at least 1/u,
    );

    const fixtureTsconfig = path.join(root, 'tsconfig.generated.json');
    await write(
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
    assert.equal(compilation.status, 0, `${compilation.stdout}${compilation.stderr}`);
  });
});

await test('resource scaffold rejects traversal and reruns without partial writes', async () => {
  await withFixture(async (root) => {
    const beforeTraversal = await snapshotTree(root);
    await assert.rejects(scaffoldResource(root, '../unsafe'), /lower-kebab-case/u);
    assert.deepEqual(await snapshotTree(root), beforeTraversal);

    await scaffoldResource(root);
    const afterFirstRun = await snapshotTree(root);
    await assert.rejects(scaffoldResource(root), /refusing to overwrite existing business file/u);
    assert.deepEqual(await snapshotTree(root), afterFirstRun);
  });
});

await test('resource scaffold leaves no artifact when generated owner slots or exports are invalid', async () => {
  await withFixture(async (root) => {
    const manifestPath = path.join(root, verticalManifestPath);
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace('// <generated-module-manifest-resources>', '// invalid-resource-slot'),
      'utf-8',
    );
    const beforeMissingSlot = await snapshotTree(root);
    await assert.rejects(scaffoldResource(root), /generated owner file/u);
    assert.deepEqual(await snapshotTree(root), beforeMissingSlot);
  });

  await withFixture(async (root) => {
    const packagePath = path.join(root, verticalPackagePath);
    const packageValue = Schema.decodeUnknownSync(packageJsonSchema, {
      onExcessProperty: 'preserve',
    })(JSON.parse(await readFile(packagePath, 'utf-8')));
    const packageWithExportCollision = {
      ...packageValue,
      exports: {
        ...packageValue.exports,
        './resources/rental-unit': './someone-elses-contract.ts',
      },
    };
    await writeFile(packagePath, json(packageWithExportCollision), 'utf-8');
    const beforeExportCollision = await snapshotTree(root);
    await assert.rejects(scaffoldResource(root), /resource contract export .* already exists/u);
    assert.deepEqual(await snapshotTree(root), beforeExportCollision);
  });
});

await test('resource scaffold upgrades the previous generated empty resourceTypes field safely', async () => {
  await withFixture(async (root) => {
    const manifestPath = path.join(root, verticalManifestPath);
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace(
        `    resourceTypes: [
      // <generated-module-manifest-resources>
      // </generated-module-manifest-resources>
    ],`,
        '    resourceTypes: [],',
      ),
      'utf-8',
    );

    await scaffoldResource(root);
    const upgraded = await readFile(manifestPath, 'utf-8');
    assert.match(upgraded, /\/\/ <generated-module-manifest-resources>/u);
    assert.match(upgraded, /rentalUnitResourceDescriptor,/u);
  });
});

void test('waits for an interrupted Codesmith write before removing its scoped output', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-scaffold-cancellation-'));
  context.after(async () => await rm(root, { force: true, recursive: true }));
  const smith = new CodeSmith({ namespace: 'ontos-scaffolding-test' });
  const core = new GeneratorCore({
    logger: smith.logger,
    materialsManager: smith.materialsManager,
    outputPath: root,
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  context.mock.method(core.output, 'fs', async () => {
    started.resolve();
    await release.promise;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'generated.ts'), 'export {};');
    events.push('write');
  });
  await runEffectTestPromise(
    Effect.gen(function* verifyWriteCleanupOrder() {
      const fileSystem = yield* FileSystem.FileSystem;
      const worker = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* writeScopedOutput() {
            yield* Effect.addFinalizer(() =>
              fileSystem
                .remove(root, { recursive: true, force: true })
                .pipe(Effect.orDie, Effect.andThen(Effect.sync(() => events.push('cleanup')))),
            );
            yield* applyMutationPlanEffect(core, {
              mutations: [
                { kind: 'create', path: path.join(root, 'generated.ts'), content: 'export {};' },
              ],
              result: undefined,
            });
          }),
        ),
      );
      yield* Effect.promise(async () => await started.promise);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(worker));
      yield* Effect.yieldNow;
      assert.deepEqual(events, []);
      release.resolve();
      yield* Fiber.join(interruption);
      assert.deepEqual(events, ['write', 'cleanup']);
      assert.equal(yield* fileSystem.exists(root), false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

void test('reports synchronous malformed-owner validation through the typed command channel', async () => {
  await withFixture(async (root) => {
    await writeFile(path.join(root, verticalPackagePath), '[]');
    const before = await snapshotTree(root);
    const failure = await runEffectTestPromise(
      runScaffoldEffect('resource', ['--vertical', verticalName, '--resource', resourceName], {
        workspaceRoot: root,
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
    assert.ok(Schema.is(ScaffoldingError)(failure));
    assert.match(failure.message, /JSON object/u);
    assert.deepEqual(await snapshotTree(root), before);
  });
});
