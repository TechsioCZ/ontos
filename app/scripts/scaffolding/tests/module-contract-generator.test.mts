import { NodeServices } from '@effect/platform-node';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { runEffectTestPromise } from '../../../packages/core-runtime/src/testing/effect-runtime.ts';
import { checkOntosModuleContracts } from '../../check-ontos-module-contracts.mts';
import {
  privateOwnerImportViolation,
  unconstrainedHttpApiContractSchemaViolation,
} from '../../ultramodern-api-boundary-rules.mts';
import { generateOntosModuleContract } from '../../generate-ontos-module-contract.mts';
import { getHelpText, runScaffoldEffect } from '../cli.mts';
import type { JsonValue } from '../shared.mts';

const APP_ID = 'property-registry';
const AUTHORIZATION_FLAG = '--authorization';
const DOCUMENTS_APP_ID = 'documents-center';
const DOCUMENTS_MODULE_ID = 'documents.center';
const MODULE_CONTRACT_COMMAND = 'module-contract';
const MODULE_ID = 'property.registry';
const PROPERTY_MANIFEST_PATH = 'verticals/property-registry/vertical.manifest.ts';
const PROPERTY_PACKAGE_PATH = 'verticals/property-registry/package.json';
const VERTICAL_FLAG = '--vertical';

const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ModuleIdSchema = Schema.String.pipe(Schema.brand('ModuleId'));
const OperationKeySchema = Schema.String.pipe(Schema.brand('OperationKey'));
const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const ModulePackageSchema = Schema.Struct({
  dependencies: StringRecordSchema,
  exports: StringRecordSchema,
  modernjs: Schema.Struct({
    ontosModule: Schema.Struct({
      contractPath: Schema.String,
      manifest: Schema.String,
      moduleId: ModuleIdSchema,
      registration: Schema.String,
      schemaVersion: Schema.Number,
    }),
  }),
  scripts: StringRecordSchema,
});
const ModuleTsconfigSchema = Schema.Struct({ include: Schema.Array(Schema.String) });
const ModuleContractDocumentSchema = Schema.Struct({
  deployment: Schema.Struct({ appId: AppIdSchema }),
  manifest: Schema.Struct({
    module: Schema.Struct({ id: ModuleIdSchema }),
    publicSurface: Schema.Struct({
      api: Schema.Array(Schema.Struct({ operationKeys: Schema.Array(OperationKeySchema) })),
    }),
  }),
  schemaVersion: Schema.String,
});
const decodeModulePackage = (source: string) =>
  Schema.decodeUnknownSync(ModulePackageSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );
const decodeModuleContract = (source: string) =>
  Schema.decodeUnknownSync(ModuleContractDocumentSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

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
    PROPERTY_PACKAGE_PATH,
    json({
      dependencies: { zeta: '1.0.0' },
      exports: { '.': './src/index.ts' },
      modernjs: {
        apiRuntime: 'effect',
        appId: APP_ID,
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
        appId: DOCUMENTS_APP_ID,
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
          id: APP_ID,
          kind: 'vertical',
          moduleFederation: { name: 'verticalPropertyRegistry', role: 'remote' },
          package: '@app/property-registry',
          path: 'verticals/property-registry',
        },
        {
          deliveryUnit: { buildMarker: 'documents-build' },
          domain: 'documents',
          id: DOCUMENTS_APP_ID,
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
      ontosModuleManifests: Object.fromEntries([
        [DOCUMENTS_APP_ID, 'http://localhost:4102/.well-known/ontos-module-manifest.json'],
        [APP_ID, 'http://localhost:4101/.well-known/ontos-module-manifest.json'],
      ]),
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

const scaffold = async (root: string, vertical = APP_ID, module = MODULE_ID) =>
  await runEffectTestPromise(
    runScaffoldEffect(MODULE_CONTRACT_COMMAND, [VERTICAL_FLAG, vertical, '--module', module], {
      workspaceRoot: root,
    }).pipe(Effect.provide(NodeServices.layer)),
  );

void test('module-contract help is exact and write-free', async () => {
  const missingRoot = path.join(tmpdir(), 'module-contract-help-does-not-exist');
  const result = await runEffectTestPromise(
    runScaffoldEffect(MODULE_CONTRACT_COMMAND, ['--help'], {
      workspaceRoot: missingRoot,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.deepEqual(result, { help: getHelpText(MODULE_CONTRACT_COMMAND), kind: 'help' });
  assert.match(result.help, /--vertical <vertical> --module <dotted\.module-id>/u);
});

void test('business generators fail closed before the mandatory module contract exists', async () => {
  await withFixture(async (root) => {
    const commands = [
      [
        'action',
        [
          VERTICAL_FLAG,
          APP_ID,
          '--action',
          'create-property',
          '--legal-entity-scope',
          'optional',
          AUTHORIZATION_FLAG,
          'action_execution',
          '--provisioning',
          'tenant_membership_default',
        ],
      ],
      ['microvertical-action-boundary', [VERTICAL_FLAG, APP_ID]],
      [
        'microvertical-page',
        [
          VERTICAL_FLAG,
          APP_ID,
          '--page',
          'properties',
          AUTHORIZATION_FLAG,
          'context_permission',
          '--permission',
          'module.access',
        ],
      ],
      [
        'outbox-message',
        [VERTICAL_FLAG, APP_ID, '--action', 'create-property', '--topic', 'property.created'],
      ],
      [
        'outbox-worker',
        [
          VERTICAL_FLAG,
          APP_ID,
          '--worker',
          'property-projector',
          '--producer',
          DOCUMENTS_APP_ID,
          '--topic',
          'document.created',
          AUTHORIZATION_FLAG,
          'owner_local_background',
        ],
      ],
      [
        'policy',
        ['--scope', 'microvertical', VERTICAL_FLAG, APP_ID, '--policy', 'property-visible'],
      ],
    ] as const;
    await Promise.all(
      commands.map(
        async ([command, flags]) =>
          await assert.rejects(
            runEffectTestPromise(
              runScaffoldEffect(command, flags, { workspaceRoot: root }).pipe(
                Effect.provide(NodeServices.layer),
              ),
            ),
            /requires scaffold:module-contract/u,
          ),
      ),
    );
  });
});

void test('rejects malformed, traversing, duplicate, and overwrite requests without partial writes', async () => {
  await withFixture(async (root) => {
    await assert.rejects(scaffold(root, '../property', MODULE_ID), /lower-kebab-case/u);
    await assert.rejects(scaffold(root, APP_ID, APP_ID), /dotted/u);
    await assert.rejects(scaffold(root, APP_ID, 'core.modules'), /non-core/u);
    await scaffold(root);
    const packageAfterFirst = await readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8');
    await assert.rejects(scaffold(root), /refusing to overwrite/u);
    assert.equal(
      await readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8'),
      packageAfterFirst,
    );
    await assert.rejects(scaffold(root, DOCUMENTS_APP_ID, MODULE_ID), /duplicate OntOS module ID/u);
  });
});

void test('generates conservative owner files and patches only package and tsconfig owner metadata', async () => {
  await withFixture(async (root) => {
    const result = await scaffold(root);
    assert.equal(result.kind, 'generated');
    const manifest = await readFile(path.join(root, PROPERTY_MANIFEST_PATH), 'utf-8');
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
    const packageJson = decodeModulePackage(
      await readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8'),
    );
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
      moduleId: MODULE_ID,
      registration: './vertical.registration.ts',
      schemaVersion: 2,
    });
    const tsconfig = Schema.decodeUnknownSync(ModuleTsconfigSchema)(
      JSON.parse(
        await readFile(path.join(root, 'verticals/property-registry/tsconfig.json'), 'utf-8'),
      ),
    );
    assert.deepEqual(tsconfig.include, [
      'src',
      'shared',
      'vertical.manifest.ts',
      'vertical.registration.ts',
    ]);
  });
});

void test('emits deterministic deployment-safe JSON and rejects damaged owner slots', async () => {
  await withFixture(async (root) => {
    await scaffold(root);
    await scaffold(root, DOCUMENTS_APP_ID, DOCUMENTS_MODULE_ID);
    const authoredManifestPath = path.join(root, PROPERTY_MANIFEST_PATH);
    const authoredManifest = await readFile(authoredManifestPath, 'utf-8');
    await writeFile(
      authoredManifestPath,
      authoredManifest
        .replace(
          '// <generated-module-manifest-imports>',
          "import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';\n\nconst PropertyApi = HttpApi.make('PropertyApi').add(\n  HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),\n);\n// <generated-module-manifest-imports>",
        )
        .replace(
          '      // <generated-module-manifest-apis>\n      // </generated-module-manifest-apis>',
          '      // <generated-module-manifest-apis>\n      PropertyApi,\n      // </generated-module-manifest-apis>',
        ),
      'utf-8',
    );
    const first = await runEffectTestPromise(
      generateOntosModuleContract({
        target: 'dist',
        vertical: APP_ID,
        workspaceRoot: root,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const firstContent = await readFile(first.path, 'utf-8');
    const packagePath = path.join(root, PROPERTY_PACKAGE_PATH);
    const packageContent = await readFile(packagePath, 'utf-8');
    const decodedPackage = decodeModulePackage(packageContent);
    const incompatiblePackage = {
      ...decodedPackage,
      modernjs: {
        ...decodedPackage.modernjs,
        ontosModule: { ...decodedPackage.modernjs.ontosModule, schemaVersion: 0 },
      },
    };
    await writeFile(packagePath, json(incompatiblePackage), 'utf-8');
    await assert.rejects(
      runEffectTestPromise(
        generateOntosModuleContract({
          target: 'dist',
          vertical: APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
      /module marker does not match/u,
    );
    assert.equal(await readFile(first.path, 'utf-8'), firstContent);
    await writeFile(packagePath, packageContent, 'utf-8');
    const second = await runEffectTestPromise(
      generateOntosModuleContract({
        target: 'dist',
        vertical: APP_ID,
        workspaceRoot: root,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.equal(await readFile(second.path, 'utf-8'), firstContent);
    assert.equal(second.etag, first.etag);
    const document = decodeModuleContract(firstContent);
    assert.equal(document.deployment.appId, APP_ID);
    assert.equal(document.manifest.module.id, MODULE_ID);
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
    const secondDeployment = await runEffectTestPromise(
      generateOntosModuleContract({
        target: 'dist',
        vertical: DOCUMENTS_APP_ID,
        workspaceRoot: root,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const secondDocument = decodeModuleContract(await readFile(secondDeployment.path, 'utf-8'));
    assert.equal(secondDocument.deployment.appId, DOCUMENTS_APP_ID);
    assert.equal(secondDocument.manifest.module.id, DOCUMENTS_MODULE_ID);

    const manifestPath = path.join(root, PROPERTY_MANIFEST_PATH);
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace('// </generated-module-manifest-actions>', ''),
      'utf-8',
    );
    await assert.rejects(
      runEffectTestPromise(
        generateOntosModuleContract({
          target: 'dist',
          vertical: APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
      /exactly one.*slot/u,
    );
  });
});

void test('maps Cloudflare emission to the Modern output root and validates authored contracts', async () => {
  await withFixture(async (root) => {
    await scaffold(root);
    await scaffold(root, DOCUMENTS_APP_ID, DOCUMENTS_MODULE_ID);
    const emitted = await runEffectTestPromise(
      generateOntosModuleContract({
        target: 'cloudflare-dist',
        vertical: APP_ID,
        workspaceRoot: root,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.match(
      emitted.path,
      /verticals\/property-registry\/dist-cloudflare\/public\/\.well-known\/ontos-module-manifest\.json$/u,
    );
    await runEffectTestPromise(
      checkOntosModuleContracts(root).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});

void test('permits owner-local registration imports but rejects cross-deployment owner imports', () => {
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

void test('requires concrete HttpApi contract schemas through Problem Details helpers', () => {
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        field: Schema.String,
      });
    `),
    undefined,
  );
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        field: Schema.Unknown,
      });
    `) ?? '',
    /must use concrete/u,
  );
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      HttpApiEndpoint.post('execute', '/reads/example', {
        success: Schema.Any,
      });
    `) ?? '',
    /must use concrete/u,
  );
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        diagnostics: Schema.Record(Schema.String, Schema.String),
      });
    `) ?? '',
    /must use concrete/u,
  );
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        diagnostics: Schema.Json,
      });
    `) ?? '',
    /must use concrete/u,
  );
});

const contractApiFixturePath = 'contracts/api.ts';
const contractBarrelFixturePath = 'contracts/barrel.ts';
const unsafeContractFixturePath = 'contracts/unsafe.ts';
const packageFixturePath = 'packages/example/package.json';
const packageSafeFixturePath = 'packages/example/src/safe.ts';
const packageUnsafeFixturePath = 'packages/example/src/unsafe.ts';
const packageSafeSchemaFixture = `export const UnsafeSchema = Schema.String;`;

void test('follows imported payload, query, parameter, success, and error schemas', () => {
  for (const member of ['payload', 'query', 'urlParams', 'success', 'error']) {
    const sources = new Map([
      [
        contractApiFixturePath,
        `
          import { UnsafeSchema } from './unsafe';
          HttpApiEndpoint.post('execute', '/reads/example', { ${member}: UnsafeSchema });
        `,
      ],
      [
        unsafeContractFixturePath,
        `export const UnsafeSchema = Schema.Struct({ nested: Schema.Unknown });`,
      ],
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
      member,
    );
  }
});

void test('covers every supported endpoint constructor through direct and aliased paths', () => {
  for (const method of ['delete', 'head', 'options']) {
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(`
        HttpApiEndpoint.${method}('execute', '/reads/example', { success: Schema.Any });
      `) ?? '',
      /must use concrete/u,
      method,
    );
  }

  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const inspectHeaders = HttpApiEndpoint.head;
      inspectHeaders('execute', '/reads/example', { success: Schema.Unknown });
    `) ?? '',
    /must use concrete/u,
  );

  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { ReexportedEndpoint } from './barrel';
        ReexportedEndpoint.options('execute', '/reads/example', { success: Schema.Any });
      `,
    ],
    [
      contractBarrelFixturePath,
      `export { HttpApiEndpoint as ReexportedEndpoint } from 'effect/unstable/httpapi';`,
    ],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows HttpApiEndpoint.make factories through local and imported helpers', () => {
  for (const source of [
    `
      HttpApiEndpoint.make('GET')('execute', '/reads/example', { success: Schema.Any });
    `,
    `
      const endpoint = HttpApiEndpoint.make('GET');
      endpoint('execute', '/reads/example', { success: Schema.Any });
    `,
    `
      const makeEndpoint = () => HttpApiEndpoint.make('GET');
      makeEndpoint()('execute', '/reads/example', { success: Schema.Any });
    `,
  ]) {
    assert.match(unconstrainedHttpApiContractSchemaViolation(source) ?? '', /must use concrete/u);
  }

  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { makeEndpoint } from './barrel';
        makeEndpoint()('execute', '/reads/example', { success: Schema.Unknown });
      `,
    ],
    [contractBarrelFixturePath, `export { makeEndpoint } from './unsafe';`],
    [
      unsafeContractFixturePath,
      `
        export function makeEndpoint() {
          return HttpApiEndpoint.make('GET');
        }
      `,
    ],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows the direct HttpApiEndpoint provider through verbs, make, and re-exports', () => {
  const provider = 'effect/unstable/httpapi/HttpApiEndpoint';
  for (const method of ['delete', 'get', 'head', 'options', 'patch', 'post', 'put']) {
    const entry = `
      import * as Endpoint from '${provider}';
      Endpoint.${method}('execute', '/reads/example', { success: Schema.Any });
    `;
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources: new Map([[contractApiFixturePath, entry]]),
      }) ?? '',
      /must use concrete/u,
      method,
    );
  }

  const makeEntry = `
    import * as Endpoint from './barrel';
    Endpoint.make('GET')('execute', '/reads/example', { success: Schema.Unknown });
  `;
  const makeSources = new Map([
    [contractApiFixturePath, makeEntry],
    [contractBarrelFixturePath, `export * from '${provider}';`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(makeEntry, {
      file: contractApiFixturePath,
      sources: makeSources,
    }) ?? '',
    /must use concrete/u,
  );

  const namespaceEntry = `
    import { Endpoint } from './barrel';
    Endpoint.get('execute', '/reads/example', { success: Schema.Any });
  `;
  const namespaceSources = new Map([
    [contractApiFixturePath, namespaceEntry],
    [contractBarrelFixturePath, `export * as Endpoint from '${provider}';`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(namespaceEntry, {
      file: contractApiFixturePath,
      sources: namespaceSources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows local and imported function helpers used as public schemas', () => {
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      function unsafeResponse() {
        return Schema.Any;
      }
      HttpApiEndpoint.get('read', '/reads/example', { success: unsafeResponse() });
    `) ?? '',
    /must use concrete/u,
  );

  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { unsafeExtensions } from './unsafe';
        makeProblemDetailsSchema('InvalidProblem', 400, unsafeExtensions());
      `,
    ],
    [
      unsafeContractFixturePath,
      `
        export function unsafeExtensions() {
          return { diagnostics: Schema.Record(Schema.String, Schema.String) };
        }
      `,
    ],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows imported arbitrary Problem Details extension records', () => {
  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { UnsafeExtensions } from './barrel';
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, UnsafeExtensions);
      `,
    ],
    [
      unsafeContractFixturePath,
      `export const ExtensionFields = { diagnostics: Schema.Record(Schema.String, Schema.String) };`,
    ],
    [contractBarrelFixturePath, `export { ExtensionFields as UnsafeExtensions } from './unsafe';`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows transitive imported schema aliases without rejecting unused unsafe exports', () => {
  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { PublicResponse } from './public-response';
        HttpApiEndpoint.get('read', '/reads/example', { success: PublicResponse });
      `,
    ],
    [
      'contracts/public-response.ts',
      `
        import { InternalResponse } from './internal-response';
        export const PublicResponse = InternalResponse;
        export const UnusedUnsafeResponse = Schema.Any;
      `,
    ],
    ['contracts/internal-response.ts', `export const InternalResponse = Schema.Json;`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );

  const safeSources = new Map([
    ...sources,
    [
      'contracts/internal-response.ts',
      `export const InternalResponse = Schema.Struct({ value: Schema.String });`,
    ] as const,
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(safeSources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
    undefined,
  );
});

void test('rejects Effect Schema namespace aliases and destructured unsafe members', () => {
  for (const unsafeSource of [
    `
      import { Schema as S } from 'effect';
      export const UnsafeSchema = S.Struct({ nested: S.Unknown });
    `,
    `
      import * as Effect from 'effect';
      const S = Effect.Schema;
      export const UnsafeSchema = S.Any;
    `,
    `
      const { Json: UnsafeJson } = Schema;
      export const UnsafeSchema = UnsafeJson;
    `,
  ]) {
    const sources = new Map([
      [
        contractApiFixturePath,
        `
          import { UnsafeSchema } from './unsafe';
          HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
        `,
      ],
      [unsafeContractFixturePath, unsafeSource],
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('follows barrel re-exports and relative namespace imports', () => {
  for (const entrySource of [
    `
      import { UnsafeSchema } from './barrel';
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `,
    `
      import * as Schemas from './unsafe';
      HttpApiEndpoint.get('read', '/reads/example', { success: Schemas.UnsafeSchema });
    `,
  ]) {
    const sources = new Map([
      [contractApiFixturePath, entrySource],
      [contractBarrelFixturePath, `export { UnsafeSchema } from './unsafe';`],
      [unsafeContractFixturePath, `export const UnsafeSchema = Schema.Any;`],
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('follows local re-exports of imported schemas', () => {
  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { PublicSchema } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: PublicSchema });
      `,
    ],
    [
      contractBarrelFixturePath,
      `
        import { UnsafeSchema } from './unsafe';
        export { UnsafeSchema as PublicSchema };
      `,
    ],
    [unsafeContractFixturePath, `export const UnsafeSchema = Schema.Any;`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('rejects direct Effect schema imports used through an aliased endpoint factory', () => {
  const content = `
    import { HttpApiEndpoint as Endpoint } from '@modern-js/plugin-bff/effect-client';
    import { Any as UnsafeSchema } from 'effect';
    Endpoint.get('read', '/reads/example', { success: UnsafeSchema });
  `;
  assert.match(unconstrainedHttpApiContractSchemaViolation(content) ?? '', /must use concrete/u);
});

void test('follows schemas imported through @app package subpaths', () => {
  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { UnsafeSchema } from '@app/example/unsafe';
        HttpApiEndpoint.get('read', '/reads/example', {
          success: UnsafeSchema,
        });
      `,
    ],
    [packageUnsafeFixturePath, `export const UnsafeSchema = Schema.Any;`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('follows star barrels, default imports, and package export maps', () => {
  const fixtures: readonly {
    readonly entry: string;
    readonly extraSources: readonly (readonly [string, string])[];
  }[] = [
    {
      entry: `
        import { UnsafeSchema } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      extraSources: [
        [contractBarrelFixturePath, `export * from './unsafe';`],
        [unsafeContractFixturePath, `export const UnsafeSchema = Schema.Any;`],
      ],
    },
    {
      entry: `
        import UnsafeSchema from './unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      extraSources: [[unsafeContractFixturePath, `export default Schema.Json;`]],
    },
    {
      entry: `
        import { UnsafeSchema } from '@app/example/api';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      extraSources: [
        [packageFixturePath, `{"name":"@app/example","exports":{"./api":"./shared/unsafe.ts"}}`],
        ['packages/example/shared/unsafe.ts', `export const UnsafeSchema = Schema.Unknown;`],
      ],
    },
  ];
  for (const fixture of fixtures) {
    const sources = new Map<string, string>([
      [contractApiFixturePath, fixture.entry],
      ...fixture.extraSources,
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('covers ordinary endpoint aliases and TypeScript module forms', () => {
  for (const content of [
    `
      const Endpoint = HttpApiEndpoint;
      Endpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
    `
      import * as S from 'effect/Schema';
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Unknown });
    `,
    `
      import { HttpApiEndpoint, Schema as S } from '@modern-js/plugin-bff/effect-client';
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Any });
    `,
  ]) {
    assert.match(unconstrainedHttpApiContractSchemaViolation(content) ?? '', /must use concrete/u);
  }

  const fixtures: readonly (readonly [string, ReadonlyMap<string, string>])[] = [
    [
      `
        import SafeDefault, { UnsafeSchema } from './unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      new Map([
        [
          unsafeContractFixturePath,
          `export default Schema.String; export const UnsafeSchema = Schema.Any;`,
        ],
      ]),
    ],
    [
      `
        import { Schemas } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: Schemas.UnsafeSchema });
      `,
      new Map([
        [contractBarrelFixturePath, `export * as Schemas from './unsafe';`],
        [unsafeContractFixturePath, `export const UnsafeSchema = Schema.Unknown;`],
      ]),
    ],
    [
      `
        import { UnsafeSchema } from '@app/example/api';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      new Map([
        [
          packageFixturePath,
          `{"exports":{"./api":{"types":"./src/unsafe.ts","default":"./dist/unsafe.js"}}}`,
        ],
        [packageUnsafeFixturePath, `export const UnsafeSchema = Schema.Any;`],
      ]),
    ],
    [
      `
        import { UnsafeSchema } from '@app/example/unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `,
      new Map([
        [packageFixturePath, `{"exports":{"./*":{"types":"./src/*.ts"}}}`],
        [packageUnsafeFixturePath, `export const UnsafeSchema = Schema.Unknown;`],
      ]),
    ],
  ];
  for (const [entry, extraSources] of fixtures) {
    const sources = new Map([[contractApiFixturePath, entry], ...extraSources]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('covers destructured, computed, and provenance-safe aliases', () => {
  for (const content of [
    `
      const { get } = HttpApiEndpoint;
      get('read', '/reads/example', { success: Schema.Any });
    `,
    `HttpApiEndpoint['get']('read', '/reads/example', { success: Schema.Unknown });`,
    `
      import * as Effect from 'effect';
      const { Schema: S } = Effect;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Json });
    `,
    `
      import * as Problems from '@app/shared-contracts/problem-details';
      const { makeProblemDetailsSchema: factory } = Problems;
      factory('InvalidProblem', 400, { values: Schema.Record(Schema.String, Schema.String) });
    `,
  ]) {
    assert.match(unconstrainedHttpApiContractSchemaViolation(content) ?? '', /must use concrete/u);
  }

  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      const Schema = { Any: 'not an Effect schema' };
      const HttpApiEndpoint = { get: () => undefined };
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
      const makeProblemDetailsSchema = () => undefined;
      makeProblemDetailsSchema('SafeLocalCall', 400, { value: Schema.Any });
    `),
    undefined,
  );
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      HttpApiEndpoint.get('read', '/reads/example', {
        success: Schema.Record(Schema.String, Schema.String),
      });
    `),
    undefined,
  );
});

void test('resolves recursive namespace exports for endpoints, factories, and schemas', () => {
  const commonSources = new Map<string, string>([
    [
      contractBarrelFixturePath,
      `
        export * as Problems from './factories';
        export * as Http from './http';
        export * as Schemas from './unsafe';
      `,
    ],
    [
      'contracts/factories.ts',
      `export { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';`,
    ],
    ['contracts/http.ts', `export { HttpApiEndpoint } from 'effect/unstable/httpapi';`],
    [unsafeContractFixturePath, `export const UnsafeSchema = Schema.Unknown;`],
  ]);
  for (const entry of [
    `
      import { Problems } from './barrel';
      Problems.makeProblemDetailsSchema('InvalidProblem', 400, { field: Schema.Any });
    `,
    `
      import { Problems } from './barrel';
      Problems.makeRetryableProblemDetailsSchema('InvalidProblem', 503, { field: Schema.Json });
    `,
    `
      import { Http } from './barrel';
      Http.HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
    `
      import * as Barrel from './barrel';
      HttpApiEndpoint.get('read', '/reads/example', { success: Barrel.Schemas.UnsafeSchema });
    `,
    `
      import { Renamed } from './renamed';
      Renamed.makeProblemDetailsSchema('InvalidProblem', 400, { field: Schema.Unknown });
    `,
  ]) {
    const sources = new Map([
      ...commonSources,
      [contractApiFixturePath, entry] as const,
      ['contracts/renamed.ts', `export { Problems as Renamed } from './barrel';`] as const,
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('resolves lexical shadows without inspecting unused inner bindings', () => {
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const ResponseSchema = Schema.Any;
      { const ResponseSchema = Schema.String; void ResponseSchema; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `) ?? '',
    /must use concrete/u,
  );
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      const ResponseSchema = Schema.String;
      { const ResponseSchema = Schema.Any; void ResponseSchema; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `),
    undefined,
  );
});

void test('evaluates package export conditions, wildcard specificity, and null exclusions', () => {
  const fixtures: readonly (readonly [string, ReadonlyMap<string, string>])[] = [
    [
      '@app/example/api',
      new Map([
        [
          packageFixturePath,
          `{"exports":{"./api":{"types":"./src/safe.d.ts","default":"./src/unsafe.ts"}}}`,
        ],
        ['packages/example/src/safe.d.ts', `export const UnsafeSchema: unknown;`],
        [packageUnsafeFixturePath, `export const UnsafeSchema = Schema.Any;`],
      ]),
    ],
    [
      '@app/example/api/schema',
      new Map([
        [packageFixturePath, `{"exports":{"./*":"./src/safe.ts","./api/*":"./src/unsafe/*.ts"}}`],
        [packageSafeFixturePath, packageSafeSchemaFixture],
        ['packages/example/src/unsafe/schema.ts', `export const UnsafeSchema = Schema.Unknown;`],
      ]),
    ],
    [
      '@app/example/api',
      new Map([
        [packageFixturePath, `{"exports":{"./blocked":null,"./api":"./unusual/unsafe.ts"}}`],
        ['packages/example/unusual/unsafe.ts', `export const UnsafeSchema = Schema.Json;`],
      ]),
    ],
  ];
  for (const [specifier, extraSources] of fixtures) {
    const entry = `
      import { UnsafeSchema } from '${specifier}';
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `;
    const sources = new Map([[contractApiFixturePath, entry], ...extraSources]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }

  const safeEntry = `
    import { ResponseSchema } from '@app/example/api';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const safeSources = new Map([
    [contractApiFixturePath, safeEntry],
    [packageFixturePath, `{"exports":{"./api":"./src/safe.ts"}}`],
    [packageSafeFixturePath, `export const ResponseSchema = Schema.String;`],
    ['packages/example/src/api.ts', `export const ResponseSchema = Schema.Any;`],
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(safeEntry, {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
    undefined,
  );

  const specificEntry = `
    import { ResponseSchema } from '@app/example/foo/bar';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const specificSources = new Map([
    [contractApiFixturePath, specificEntry],
    [packageFixturePath, `{"exports":{"./foo/*":"./src/safe.ts","./*/bar":"./src/unsafe.ts"}}`],
    [packageSafeFixturePath, `export const ResponseSchema = Schema.String;`],
    [packageUnsafeFixturePath, `export const ResponseSchema = Schema.Any;`],
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(specificEntry, {
      file: contractApiFixturePath,
      sources: specificSources,
    }),
    undefined,
  );
});

void test('terminates on safe and unsafe cyclic re-exports', () => {
  const entry = `
    import { ResponseSchema } from './cycle-a';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const safeSources = new Map([
    [contractApiFixturePath, entry],
    ['contracts/cycle-a.ts', `export * from './cycle-b';`],
    [
      'contracts/cycle-b.ts',
      `export * from './cycle-a'; export const ResponseSchema = Schema.String;`,
    ],
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
    undefined,
  );
  const unsafeSources = new Map([
    ...safeSources,
    [
      'contracts/cycle-b.ts',
      `export * from './cycle-a'; export const ResponseSchema = Schema.Any;`,
    ] as const,
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: unsafeSources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('honors explicit export precedence and star-export binding identity', () => {
  const entry = `
    import { ResponseSchema } from './barrel';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const explicitSources = new Map([
    [contractApiFixturePath, entry],
    [
      contractBarrelFixturePath,
      `export { SafeSchema as ResponseSchema } from './safe'; export * from './unsafe';`,
    ],
    ['contracts/safe.ts', `export const SafeSchema = Schema.String;`],
    [unsafeContractFixturePath, `export const ResponseSchema = Schema.Any;`],
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: explicitSources,
    }),
    undefined,
  );

  const diamondSources = new Map([
    [contractApiFixturePath, entry],
    [contractBarrelFixturePath, `export * from './left'; export * from './right';`],
    ['contracts/left.ts', `export * from './origin';`],
    ['contracts/right.ts', `export * from './origin';`],
    ['contracts/origin.ts', `export const ResponseSchema = Schema.Unknown;`],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: diamondSources,
    }) ?? '',
    /must use concrete/u,
  );

  const ambiguousSources = new Map([
    ...diamondSources,
    ['contracts/left.ts', `export const ResponseSchema = Schema.String;`] as const,
    ['contracts/right.ts', `export const ResponseSchema = Schema.Any;`] as const,
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: ambiguousSources,
    }),
    undefined,
  );
});

void test('uses TypeScript source and relative-file resolution precedence', () => {
  const entry = `
    import { ResponseSchema } from './foo';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const sources = new Map([
    [contractApiFixturePath, entry],
    ['contracts/foo.ts', `export const ResponseSchema = Schema.String;`],
    ['contracts/foo/index.ts', `export const ResponseSchema = Schema.Any;`],
  ]);
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources,
    }),
    undefined,
  );

  const nodeNextEntry = `
    import { ResponseSchema } from './foo.js';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const nodeNextSources = new Map([
    ...sources,
    [contractApiFixturePath, nodeNextEntry] as const,
    ['contracts/foo.ts', `export const ResponseSchema = Schema.Json;`] as const,
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(nodeNextEntry, {
      file: contractApiFixturePath,
      sources: nodeNextSources,
    }) ?? '',
    /must use concrete/u,
  );
});

void test('tracks object, mutable, rest, var, enum, and namespace provenance', () => {
  for (const content of [
    `
      const Endpoints = { endpoint: HttpApiEndpoint };
      Endpoints.endpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
    `
      let Endpoint = { get: () => undefined };
      Endpoint = HttpApiEndpoint;
      Endpoint.get('read', '/reads/example', { success: Schema.Unknown });
    `,
    `
      let factory = () => undefined;
      factory = makeProblemDetailsSchema;
      factory('InvalidProblem', 400, { values: Schema.Record(Schema.String, Schema.String) });
    `,
    `
      const all = { ...Schema };
      HttpApiEndpoint.get('read', '/reads/example', { success: all['A' + 'ny'] });
    `,
    `
      const { ['Any']: UnsafeSchema } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `,
    `
      const { ...S } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Any });
    `,
    `
      const key = 'Unknown';
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema[key] });
    `,
    `
      const holder = { endpoint: undefined };
      holder.endpoint = HttpApiEndpoint;
      holder.endpoint.get('read', '/reads/example', { success: Schema.Unknown });
    `,
    `
      let ResponseSchema = Schema.String;
      { ResponseSchema = Schema.Any; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `,
    `
      let ResponseSchema = Schema.Any;
      if (false) ResponseSchema = Schema.String;
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `,
  ]) {
    assert.match(unconstrainedHttpApiContractSchemaViolation(content) ?? '', /must use concrete/u);
  }

  for (const content of [
    `
      import { Schema } from 'effect';
      function fixture() {
        { var Schema = { Any: 'safe' }; }
        HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
      }
      fixture();
    `,
    `
      namespace HttpApiEndpoint { export const get = () => undefined; }
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
    `
      enum HttpApiEndpoint { get }
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
  ]) {
    assert.equal(unconstrainedHttpApiContractSchemaViolation(content), undefined);
  }
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      const { String, ...S } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.String });
    `),
    undefined,
  );
});

void test('follows external schema and endpoint provider re-exports', () => {
  const fixtures: readonly (readonly [string, string])[] = [
    [`export * from 'effect/Schema';`, `import { Any as UnsafeSchema } from './barrel';`],
    [
      `export { Unknown as UnsafeSchema } from 'effect';`,
      `import { UnsafeSchema } from './barrel';`,
    ],
    [
      `export * as S from 'effect/Schema';`,
      `import { S } from './barrel'; const UnsafeSchema = S.Any;`,
    ],
  ];
  for (const [barrel, imported] of fixtures) {
    const entry = `${imported}
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });`;
    const sources = new Map([
      [contractApiFixturePath, entry],
      [contractBarrelFixturePath, barrel],
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }

  for (const barrel of [
    `export * from 'effect/unstable/httpapi';`,
    `export * as Http from 'effect/unstable/httpapi';`,
  ]) {
    const imported = barrel.includes('* as')
      ? `import { Http } from './barrel'; Http.HttpApiEndpoint`
      : `import { HttpApiEndpoint as Endpoint } from './barrel'; Endpoint`;
    const entry = `${imported}.get('read', '/reads/example', { success: Schema.Any });`;
    const sources = new Map([
      [contractApiFixturePath, entry],
      [contractBarrelFixturePath, barrel],
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      /must use concrete/u,
    );
  }
});

void test('follows local and imported aliases of Problem Details factories', () => {
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(`
      const factory = makeProblemDetailsSchema;
      const InvalidProblem = factory('InvalidProblem', 400, { field: Schema.Unknown });
    `) ?? '',
    /must use concrete/u,
  );
  assert.equal(
    unconstrainedHttpApiContractSchemaViolation(`
      const factory = makeProblemDetailsSchema;
      const ValidProblem = factory('ValidProblem', 400, { field: Schema.String });
    `),
    undefined,
  );

  const sources = new Map([
    [
      contractApiFixturePath,
      `
        import { factory } from './factory';
        import { UnsafeExtensions } from './unsafe';
        const InvalidProblem = factory('InvalidProblem', 400, UnsafeExtensions);
      `,
    ],
    ['contracts/factory.ts', `export const factory = makeProblemDetailsSchema;`],
    [
      unsafeContractFixturePath,
      `export const UnsafeExtensions = { values: Schema.Record(Schema.String, Schema.String) };`,
    ],
  ]);
  assert.match(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
    /must use concrete/u,
  );
  for (const extensions of [
    `{ field: Schema.Unknown }`,
    `{ values: Schema.Record(Schema.String, Schema.String) }`,
  ]) {
    const inlineSources = new Map([
      ...sources,
      [
        contractApiFixturePath,
        `
          import { factory } from './factory';
          const InvalidProblem = factory('InvalidProblem', 400, ${extensions});
        `,
      ] as const,
    ]);
    assert.match(
      unconstrainedHttpApiContractSchemaViolation(inlineSources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources: inlineSources,
      }) ?? '',
      /must use concrete/u,
    );
  }
  for (const factoryName of ['makeProblemDetailsSchema', 'makeRetryableProblemDetailsSchema']) {
    const factorySources = new Map([
      ['contracts/factory.ts', `export const factory = ${factoryName};`],
      [
        unsafeContractFixturePath,
        `
          export const RecordAlias = Schema.Record(Schema.String, Schema.String);
          export const UnsafeExtensions = { values: RecordAlias };
        `,
      ],
    ]);
    for (const entry of [
      `
        import { factory } from './factory';
        const RecordAlias = Schema.Record(Schema.String, Schema.String);
        factory('InvalidProblem', 400, { values: RecordAlias });
      `,
      `
        import { factory } from './factory';
        import { RecordAlias } from './unsafe';
        factory('InvalidProblem', 400, { values: RecordAlias });
      `,
      `
        import { factory } from './factory';
        import * as Extensions from './unsafe';
        factory('InvalidProblem', 400, Extensions.UnsafeExtensions);
      `,
    ]) {
      const aliasedSources = new Map([...factorySources, [contractApiFixturePath, entry] as const]);
      assert.match(
        unconstrainedHttpApiContractSchemaViolation(entry, {
          file: contractApiFixturePath,
          sources: aliasedSources,
        }) ?? '',
        /must use concrete/u,
      );
    }
  }
});
