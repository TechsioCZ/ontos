import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkOntosModuleContracts } from '../../check-ontos-module-contracts.mts';
import { privateOwnerImportViolation } from '../../ultramodern-api-boundary-rules.mts';
import { generateOntosModuleContract } from '../../generate-ontos-module-contract.mts';
import { getHelpText, runScaffold } from '../cli.mts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const write = async (root: string, relative: string, content: string): Promise<void> => {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
};

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-module-contract-'));
  await write(root, 'package.json', json({ name: 'fixture', private: true, type: 'module' }));
  await write(
    root,
    'verticals/property-registry/package.json',
    json({
      dependencies: { zeta: '1.0.0' },
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
        existing: 'preserve-me',
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
    `export default { exposes: {} };\n`,
  );
  await write(
    root,
    'verticals/documents-center/package.json',
    json({
      dependencies: {},
      modernjs: {
        appId: 'documents-center',
        role: 'module-federation-remote',
        topology: '../../topology/reference-topology.json',
      },
      name: '@app/documents-center',
      private: true,
      scripts: {
        build: 'modern build',
        'cloudflare:build': 'MODERNJS_DEPLOY=cloudflare modern build',
      },
      type: 'module',
      version: '0.1.0',
    }),
  );
  await write(
    root,
    'verticals/documents-center/tsconfig.json',
    json({ compilerOptions: { composite: true }, include: ['src'], references: [] }),
  );
  await write(
    root,
    'verticals/documents-center/module-federation.config.ts',
    'export default {};\n',
  );
  await write(
    root,
    'topology/reference-topology.json',
    json({
      schemaVersion: 1,
      verticals: [
        {
          deliveryUnit: { buildMarker: 'property-build' },
          domain: 'property',
          id: 'property-registry',
          kind: 'vertical',
          moduleFederation: { name: 'verticalPropertyRegistry', role: 'remote' },
          package: '@app/property-registry',
          path: 'verticals/property-registry',
        },
        {
          deliveryUnit: { buildMarker: 'documents-build' },
          domain: 'documents',
          id: 'documents-center',
          kind: 'vertical',
          moduleFederation: { name: 'verticalDocumentsCenter', role: 'remote' },
          package: '@app/documents-center',
          path: 'verticals/documents-center',
        },
      ],
    }),
  );
  await write(
    root,
    'topology/local-overlays/development.json',
    json({
      environment: 'development',
      ontosModuleManifests: {
        'documents-center': 'http://localhost:4102/.well-known/ontos-module-manifest.json',
        'property-registry': 'http://localhost:4101/.well-known/ontos-module-manifest.json',
      },
      schemaVersion: 1,
    }),
  );
  await mkdir(path.join(root, 'node_modules', '@app'), { recursive: true });
  await symlink(
    path.join(appRoot, 'packages/core-runtime'),
    path.join(root, 'node_modules/@app/core-runtime'),
    'dir',
  );
  await symlink(path.join(appRoot, 'node_modules/effect'), path.join(root, 'node_modules/effect'));
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

const scaffold = (root: string, vertical = 'property-registry', module = 'property.registry') =>
  runScaffold('module-contract', ['--vertical', vertical, '--module', module], {
    workspaceRoot: root,
  });

test('module-contract help is exact and write-free', async () => {
  const missingRoot = path.join(tmpdir(), 'module-contract-help-does-not-exist');
  const result = await runScaffold('module-contract', ['--help'], { workspaceRoot: missingRoot });
  assert.deepEqual(result, { help: getHelpText('module-contract'), kind: 'help' });
  assert.match(result.help, /--vertical <vertical> --module <dotted\.module-id>/u);
});

test('business generators fail closed before the mandatory module contract exists', async () => {
  await withFixture(async (root) => {
    const commands = [
      [
        'action',
        [
          '--vertical',
          'property-registry',
          '--action',
          'create-property',
          '--legal-entity-scope',
          'optional',
        ],
      ],
      ['microvertical-action-boundary', ['--vertical', 'property-registry']],
      ['microvertical-page', ['--vertical', 'property-registry', '--page', 'properties']],
      [
        'outbox-message',
        [
          '--vertical',
          'property-registry',
          '--action',
          'create-property',
          '--topic',
          'property.created',
        ],
      ],
      [
        'outbox-worker',
        [
          '--vertical',
          'property-registry',
          '--worker',
          'property-projector',
          '--producer',
          'documents-center',
          '--topic',
          'document.created',
        ],
      ],
      [
        'policy',
        [
          '--scope',
          'microvertical',
          '--vertical',
          'property-registry',
          '--policy',
          'property-visible',
        ],
      ],
    ] as const;
    await Promise.all(
      commands.map(([command, flags]) =>
        assert.rejects(
          runScaffold(command, flags, { workspaceRoot: root }),
          /requires scaffold:module-contract/u,
        ),
      ),
    );
  });
});

test('rejects malformed, traversing, duplicate, and overwrite requests without partial writes', async () => {
  await withFixture(async (root) => {
    await assert.rejects(scaffold(root, '../property', 'property.registry'), /lower-kebab-case/u);
    await assert.rejects(scaffold(root, 'property-registry', 'property-registry'), /dotted/u);
    await assert.rejects(scaffold(root, 'property-registry', 'core.modules'), /non-core/u);
    await scaffold(root);
    const packageAfterFirst = await readFile(
      path.join(root, 'verticals/property-registry/package.json'),
      'utf-8',
    );
    await assert.rejects(scaffold(root), /refusing to overwrite/u);
    assert.equal(
      await readFile(path.join(root, 'verticals/property-registry/package.json'), 'utf-8'),
      packageAfterFirst,
    );
    await assert.rejects(
      scaffold(root, 'documents-center', 'property.registry'),
      /duplicate OntOS module ID/u,
    );
  });
});

test('generates conservative owner files and patches only package and tsconfig owner metadata', async () => {
  await withFixture(async (root) => {
    const result = await scaffold(root);
    assert.equal(result.kind, 'generated');
    const manifest = await readFile(
      path.join(root, 'verticals/property-registry/vertical.manifest.ts'),
      'utf-8',
    );
    const registration = await readFile(
      path.join(root, 'verticals/property-registry/vertical.registration.ts'),
      'utf-8',
    );
    assert.match(manifest, /@ontos-deployment-app-id property-registry/u);
    assert.match(manifest, /@ontos-module-id property\.registry/u);
    assert.match(manifest, /defaultState: 'inactive'/u);
    assert.doesNotMatch(manifest, /dependencies:|core\.identity|externalSystems/u);
    const retiredLifecycleMarkers = [
      ['must', 'be', 'active', 'first'].join('_'),
      ['enable', 'together', 'when', 'available'].join('_'),
      ['optional', 'enhancement'].join('_'),
      ['integration', 'required', 'for', 'api'].join('_'),
    ];
    for (const marker of retiredLifecycleMarkers) {
      assert.equal(manifest.includes(marker), false);
    }
    assert.match(manifest, /actions: \[/u);
    assert.match(registration, /defineVerticalRuntimeRegistration/u);
    assert.match(registration, /generated-module-registration-workers/u);
    assert.doesNotMatch(registration, /handler|migration|route/u);
    const packageJson = JSON.parse(
      await readFile(path.join(root, 'verticals/property-registry/package.json'), 'utf-8'),
    ) as {
      dependencies: Record<string, string>;
      exports: Record<string, string>;
      modernjs: { ontosModule: Record<string, unknown> };
      scripts: Record<string, string>;
    };
    assert.deepEqual(packageJson.dependencies, {
      '@app/core-runtime': 'workspace:*',
      zeta: '1.0.0',
    });
    assert.deepEqual(packageJson.exports, { '.': './src/index.ts' });
    assert.equal(packageJson.scripts['existing'], 'preserve-me');
    assert.match(packageJson.scripts['build'] ?? '', /--vertical property-registry --target dist/u);
    assert.match(
      packageJson.scripts['cloudflare:build'] ?? '',
      /--vertical property-registry --target cloudflare-dist/u,
    );
    assert.deepEqual(packageJson.modernjs.ontosModule, {
      contractPath: '/.well-known/ontos-module-manifest.json',
      manifest: './vertical.manifest.ts',
      moduleId: 'property.registry',
      registration: './vertical.registration.ts',
      schemaVersion: 2,
    });
    const tsconfig = JSON.parse(
      await readFile(path.join(root, 'verticals/property-registry/tsconfig.json'), 'utf-8'),
    ) as { include: string[] };
    assert.deepEqual(tsconfig.include, [
      'src',
      'shared',
      'vertical.manifest.ts',
      'vertical.registration.ts',
    ]);
  });
});

test('emits deterministic deployment-safe JSON and rejects damaged owner slots', async () => {
  await withFixture(async (root) => {
    await scaffold(root);
    await scaffold(root, 'documents-center', 'documents.center');
    const authoredManifestPath = path.join(
      root,
      'verticals/property-registry/vertical.manifest.ts',
    );
    const authoredManifest = await readFile(authoredManifestPath, 'utf-8');
    await writeFile(
      authoredManifestPath,
      authoredManifest
        .replace(
          "import { defineOntosModuleManifest } from '@app/core-runtime';",
          "import { defineOntosModuleManifest } from '@app/core-runtime';\nimport { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';\n\nconst PropertyApi = HttpApi.make('PropertyApi').add(\n  HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),\n);",
        )
        .replace(
          '      // <generated-module-manifest-apis>\n      // </generated-module-manifest-apis>',
          '      // <generated-module-manifest-apis>\n      PropertyApi,\n      // </generated-module-manifest-apis>',
        ),
      'utf-8',
    );
    const first = await generateOntosModuleContract({
      target: 'dist',
      vertical: 'property-registry',
      workspaceRoot: root,
    });
    const firstContent = await readFile(first.path, 'utf-8');
    const packagePath = path.join(root, 'verticals/property-registry/package.json');
    const packageContent = await readFile(packagePath, 'utf-8');
    const incompatiblePackage = JSON.parse(packageContent) as {
      modernjs: { ontosModule: { schemaVersion: number } };
    };
    incompatiblePackage.modernjs.ontosModule.schemaVersion = 0;
    await writeFile(packagePath, json(incompatiblePackage), 'utf-8');
    await assert.rejects(
      generateOntosModuleContract({
        target: 'dist',
        vertical: 'property-registry',
        workspaceRoot: root,
      }),
      /module marker does not match/u,
    );
    assert.equal(await readFile(first.path, 'utf-8'), firstContent);
    await writeFile(packagePath, packageContent, 'utf-8');
    const second = await generateOntosModuleContract({
      target: 'dist',
      vertical: 'property-registry',
      workspaceRoot: root,
    });
    assert.equal(await readFile(second.path, 'utf-8'), firstContent);
    assert.equal(second.etag, first.etag);
    const document = JSON.parse(firstContent) as {
      deployment: { appId: string };
      manifest: {
        module: { id: string };
        publicSurface: { api: readonly { operationKeys: readonly string[] }[] };
      };
      schemaVersion: string;
    };
    assert.equal(document.deployment.appId, 'property-registry');
    assert.equal(document.manifest.module.id, 'property.registry');
    assert.equal(document.schemaVersion, '2');
    assert.equal(Object.hasOwn(document.manifest, 'dependencies'), false);
    assert.deepEqual(document.manifest.publicSurface.api[0]?.operationKeys, ['property.listUnits']);
    assert.doesNotMatch(firstContent, /vertical\.registration|function|handler|sourcePath/u);
    const headers = await readFile(
      path.join(root, 'verticals/property-registry/dist/public/_headers'),
      'utf-8',
    );
    assert.match(headers, /Cache-Control: no-cache/u);
    assert.match(headers, /Content-Type: application\/json/u);
    assert.match(headers, /ETag: "[a-f0-9]{64}"/u);
    const secondDeployment = await generateOntosModuleContract({
      target: 'dist',
      vertical: 'documents-center',
      workspaceRoot: root,
    });
    const secondDocument = JSON.parse(await readFile(secondDeployment.path, 'utf-8')) as {
      deployment: { appId: string };
      manifest: { module: { id: string } };
    };
    assert.equal(secondDocument.deployment.appId, 'documents-center');
    assert.equal(secondDocument.manifest.module.id, 'documents.center');

    const manifestPath = path.join(root, 'verticals/property-registry/vertical.manifest.ts');
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace('// </generated-module-manifest-actions>', ''),
      'utf-8',
    );
    await assert.rejects(
      generateOntosModuleContract({
        target: 'dist',
        vertical: 'property-registry',
        workspaceRoot: root,
      }),
      /exactly one.*slot/u,
    );
  });
});

test('maps Cloudflare emission to the Modern output root and validates authored contracts', async () => {
  await withFixture(async (root) => {
    await scaffold(root);
    await scaffold(root, 'documents-center', 'documents.center');
    const emitted = await generateOntosModuleContract({
      target: 'cloudflare-dist',
      vertical: 'property-registry',
      workspaceRoot: root,
    });
    assert.match(
      emitted.path,
      /verticals\/property-registry\/dist-cloudflare\/public\/\.well-known\/ontos-module-manifest\.json$/u,
    );
    await checkOntosModuleContracts(root);
  });
});

test('permits owner-local registration imports but rejects cross-deployment owner imports', () => {
  const root = '/workspace/app';
  assert.equal(
    privateOwnerImportViolation(
      root,
      'verticals/billing/src/worker-host/main.ts',
      '../../vertical.registration.ts',
    ),
    undefined,
  );
  assert.match(
    privateOwnerImportViolation(
      root,
      'verticals/billing/src/worker-host/main.ts',
      '../../../inventory-stock/vertical.registration.ts',
    ) ?? '',
    /only its own/u,
  );
  assert.match(
    privateOwnerImportViolation(
      root,
      'verticals/billing/vertical.registration.ts',
      '../inventory-stock/vertical.registration.ts',
    ) ?? '',
    /only its own/u,
  );
  assert.match(
    privateOwnerImportViolation(
      root,
      'apps/shell-super-app/api/index.ts',
      '../../../verticals/billing/vertical.registration.ts',
    ) ?? '',
    /may not import/u,
  );
});
