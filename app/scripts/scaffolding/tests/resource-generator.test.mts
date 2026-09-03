import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import { getHelpText, runScaffold } from '../cli.mts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

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
    'verticals/property-registry/package.json',
    json({
      dependencies: { effect: '4.0.0-beta.107' },
      exports: { '.': './src/index.ts' },
      modernjs: {
        apiRuntime: 'effect',
        appId: 'property-registry',
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
    json({ compilerOptions: { composite: true }, include: ['src', 'shared'], references: [] }),
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
          id: 'property-registry',
          kind: 'vertical',
          moduleFederation: { name: 'verticalPropertyRegistry', role: 'remote' },
          package: '@app/property-registry',
          path: 'verticals/property-registry',
        },
      ],
    }),
  );
  await write(
    root,
    'types/core-runtime.d.ts',
    `export interface OntosResourceType {
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
`,
  );
  await mkdir(path.join(root, 'node_modules', '@app'), { recursive: true });
  await symlink(
    path.join(appRoot, 'packages/core-runtime'),
    path.join(root, 'node_modules/@app/core-runtime'),
    'dir',
  );
  await symlink(path.join(appRoot, 'node_modules/effect'), path.join(root, 'node_modules/effect'));
  await runScaffold(
    'module-contract',
    ['--vertical', 'property-registry', '--module', 'property.registry'],
    { workspaceRoot: root },
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

const scaffoldResource = (root: string, resource = 'rental-unit') =>
  runScaffold('resource', ['--vertical', 'property-registry', '--resource', resource], {
    workspaceRoot: root,
  });

test('resource help documents the public command and writes nothing', async () => {
  const missingRoot = path.join(tmpdir(), 'resource-help-does-not-exist');
  const result = await runScaffold('resource', ['--help'], { workspaceRoot: missingRoot });
  assert.deepEqual(result, { help: getHelpText('resource'), kind: 'help' });
  assert.match(result.help, /scaffold:resource -- --vertical <vertical> --resource <resource>/u);
  assert.match(result.help, /lower-kebab-case/u);
});

test('resource scaffold publishes a typed ResourceRef and registers its descriptor', async () => {
  await withFixture(async (root) => {
    const result = await scaffoldResource(root);
    assert.equal(result.kind, 'generated');

    const resourcePath = path.join(
      root,
      'verticals/property-registry/shared/resources/rental-unit.ts',
    );
    const [resource, manifest, packageSource] = await Promise.all([
      readFile(resourcePath, 'utf-8'),
      readFile(path.join(root, 'verticals/property-registry/vertical.manifest.ts'), 'utf-8'),
      readFile(path.join(root, 'verticals/property-registry/package.json'), 'utf-8'),
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
    const modulePackage = Schema.decodeUnknownSync(
      Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
      { onExcessProperty: 'preserve' },
    )(JSON.parse(packageSource));
    assert.equal(
      modulePackage.exports['./resources/rental-unit'],
      './shared/resources/rental-unit.ts',
    );

    const generatedModule = await import(`${pathToFileURL(resourcePath).href}?test=${Date.now()}`);
    const reference = Schema.decodeUnknownSync(generatedModule.RentalUnitRefSchema)({
      moduleId: 'property.registry',
      resourceId: 'unit-42',
      resourceType: 'property.registry.rental-unit',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    assert.deepEqual(reference, {
      moduleId: 'property.registry',
      resourceId: 'unit-42',
      resourceType: 'property.registry.rental-unit',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    assert.throws(
      () =>
        Schema.decodeUnknownSync(generatedModule.RentalUnitRefSchema)({
          moduleId: 'property.registry',
          resourceId: '',
          resourceType: 'property.registry.rental-unit',
          tenantId: '00000000-0000-4000-8000-000000000001',
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
        include: [
          'verticals/property-registry/shared/resources/**/*.ts',
          'verticals/property-registry/vertical.manifest.ts',
        ],
      }),
    );
    const compilation = spawnSync(tscPath, ['-p', fixtureTsconfig], {
      cwd: root,
      encoding: 'utf-8',
    });
    assert.equal(compilation.status, 0, `${compilation.stdout}${compilation.stderr}`);
  });
});

test('resource scaffold rejects traversal and reruns without partial writes', async () => {
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

test('resource scaffold leaves no artifact when generated owner slots or exports are invalid', async () => {
  await withFixture(async (root) => {
    const manifestPath = path.join(root, 'verticals/property-registry/vertical.manifest.ts');
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
    const packagePath = path.join(root, 'verticals/property-registry/package.json');
    const packageValue = JSON.parse(await readFile(packagePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    packageValue['exports'] = {
      ...((packageValue['exports'] ?? {}) as Record<string, unknown>),
      './resources/rental-unit': './someone-elses-contract.ts',
    };
    await writeFile(packagePath, json(packageValue), 'utf-8');
    const beforeExportCollision = await snapshotTree(root);
    await assert.rejects(scaffoldResource(root), /resource contract export .* already exists/u);
    assert.deepEqual(await snapshotTree(root), beforeExportCollision);
  });
});

test('resource scaffold upgrades the previous generated empty resourceTypes field safely', async () => {
  await withFixture(async (root) => {
    const manifestPath = path.join(root, 'verticals/property-registry/vertical.manifest.ts');
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
