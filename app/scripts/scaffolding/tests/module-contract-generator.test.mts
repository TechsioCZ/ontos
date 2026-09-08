import { Cause, Effect, Schema } from 'effect';
import { expect, it } from '@app/effect-rstest';
import { NodeServices } from '@effect/platform-node';

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { privateOwnerImportViolation } from '../../ultramodern-api-boundary-rules.mts';
// Match the native module identity used by the generated fixture's owner bundle.

import { getHelpText, runScaffoldEffect } from '../cli.mts';
import type { JsonValue } from '../shared.mts';

const { checkOntosModuleContracts } = await import(
  /* webpackIgnore: true */
  '../../check-ontos-module-contracts.mts'
);
const { generateOntosModuleContract } = await import(
  /* webpackIgnore: true */
  '../../generate-ontos-module-contract.mts'
);

const expectFailure = <A, E, R>(self: Effect.Effect<A, E, R>, check: (cause: unknown) => void) =>
  Effect.matchCauseEffect(self, {
    onFailure: (cause) => Effect.sync(() => check(Cause.squash(cause))),
    onSuccess: () =>
      Effect.sync(() => {
        throw new Error('Expected operation to fail');
      }),
  });

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

const write = (root: string, relative: string, content: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario1() {
    const target = path.join(root, relative);
    yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }));
    yield* Effect.promise(() => writeFile(target, content, 'utf-8'));
  });

const createFixture = (): Effect.Effect<string, unknown> =>
  Effect.gen(function* scenario2() {
    const root = yield* Effect.promise(() =>
      mkdtemp(path.join(tmpdir(), 'ontos-module-contract-')),
    );
    yield* write(root, 'package.json', json({ name: 'fixture', private: true, type: 'module' }));
    yield* write(
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
    yield* write(
      root,
      'verticals/property-registry/tsconfig.json',
      json({ compilerOptions: { composite: true }, include: ['src', 'shared'], references: [] }),
    );
    yield* write(
      root,
      'verticals/property-registry/module-federation.config.ts',
      `export default { exposes: {} };\n`,
    );
    yield* write(
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
    yield* write(
      root,
      'verticals/documents-center/tsconfig.json',
      json({ compilerOptions: { composite: true }, include: ['src'], references: [] }),
    );
    yield* write(
      root,
      'verticals/documents-center/module-federation.config.ts',
      'export default {};\n',
    );
    yield* write(
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
    yield* write(
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
    yield* Effect.promise(() =>
      mkdir(path.join(root, 'node_modules', '@app'), { recursive: true }),
    );
    yield* Effect.promise(() =>
      symlink(
        path.join(appRoot, 'packages/core-runtime'),
        path.join(root, 'node_modules/@app/core-runtime'),
        'dir',
      ),
    );
    yield* Effect.promise(() =>
      symlink(path.join(appRoot, 'node_modules/effect'), path.join(root, 'node_modules/effect')),
    );
    return root;
  });

const withFixture = (
  run: (root: string) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario3() {
    const root = yield* createFixture();
    yield* run(root).pipe(
      Effect.ensuring(Effect.promise(() => rm(root, { force: true, recursive: true }))),
    );
  });

const scaffold = Effect.fn(function* scenario4(
  root: string,
  vertical = APP_ID,
  module = MODULE_ID,
) {
  return yield* runScaffoldEffect(
    MODULE_CONTRACT_COMMAND,
    [VERTICAL_FLAG, vertical, '--module', module],
    {
      workspaceRoot: root,
    },
  ).pipe(Effect.provide(NodeServices.layer));
});

it.live(
  'module-contract help is exact and write-free',
  Effect.fn(function* scenario5() {
    const missingRoot = path.join(tmpdir(), 'module-contract-help-does-not-exist');
    const result = yield* runScaffoldEffect(MODULE_CONTRACT_COMMAND, ['--help'], {
      workspaceRoot: missingRoot,
    }).pipe(Effect.provide(NodeServices.layer));
    expect(result).toEqual({ help: getHelpText(MODULE_CONTRACT_COMMAND), kind: 'help' });
    if (result.kind !== 'help') {
      throw new Error('Expected help result');
    }
    expect(result.help).toMatch(/--vertical <vertical> --module <dotted\.module-id>/u);
  }),
);

it.live(
  'business generators fail closed before the mandatory module contract exists',
  Effect.fn(function* scenario6() {
    yield* withFixture(
      Effect.fn(function* scenario7(root) {
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
        yield* Effect.all(
          commands.map(
            Effect.fn(function* scenario8([command, flags]) {
              return yield* expectFailure(
                runScaffoldEffect(command, flags, { workspaceRoot: root }).pipe(
                  Effect.provide(NodeServices.layer),
                ),
                (error) => expect(String(error)).toMatch(/requires scaffold:module-contract/u),
              );
            }),
          ),
          { concurrency: 'unbounded' },
        );
      }),
    );
  }),
);

it.live(
  'rejects malformed, traversing, duplicate, and overwrite requests without partial writes',
  Effect.fn(function* scenario9() {
    yield* withFixture(
      Effect.fn(function* scenario10(root) {
        yield* expectFailure(scaffold(root, '../property', MODULE_ID), (error) =>
          expect(String(error)).toMatch(/lower-kebab-case/u),
        );
        yield* expectFailure(scaffold(root, APP_ID, APP_ID), (error) =>
          expect(String(error)).toMatch(/dotted/u),
        );
        yield* expectFailure(scaffold(root, APP_ID, 'core.modules'), (error) =>
          expect(String(error)).toMatch(/non-core/u),
        );
        yield* scaffold(root);
        const packageAfterFirst = yield* Effect.promise(() =>
          readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8'),
        );
        yield* expectFailure(scaffold(root), (error) =>
          expect(String(error)).toMatch(/refusing to overwrite/u),
        );
        expect(
          yield* Effect.promise(() => readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8')),
        ).toBe(packageAfterFirst);
        yield* expectFailure(scaffold(root, DOCUMENTS_APP_ID, MODULE_ID), (error) =>
          expect(String(error)).toMatch(/duplicate OntOS module ID/u),
        );
      }),
    );
  }),
);

it.live(
  'generates conservative owner files and patches only package and tsconfig owner metadata',
  Effect.fn(function* scenario11() {
    yield* withFixture(
      Effect.fn(function* scenario12(root) {
        const result = yield* scaffold(root);
        expect(result.kind).toBe('generated');
        const manifest = yield* Effect.promise(() =>
          readFile(path.join(root, PROPERTY_MANIFEST_PATH), 'utf-8'),
        );
        const registration = yield* Effect.promise(() =>
          readFile(
            path.join(root, 'verticals/property-registry/vertical.registration.ts'),
            'utf-8',
          ),
        );
        expect(manifest).toMatch(/@ontos-deployment-app-id property-registry/u);
        expect(manifest).toMatch(/@ontos-module-id property\.registry/u);
        expect(manifest).toMatch(/defaultState: 'inactive'/u);
        expect(manifest).not.toMatch(/dependencies:|core\.identity|externalSystems/u);
        const retiredLifecycleMarkers = [
          ['must', 'be', 'active', 'first'].join('_'),
          ['enable', 'together', 'when', 'available'].join('_'),
          ['optional', 'enhancement'].join('_'),
          ['integration', 'required', 'for', 'api'].join('_'),
        ];
        for (const marker of retiredLifecycleMarkers) {
          expect(manifest.includes(marker)).toBe(false);
        }
        expect(manifest).toMatch(/actions: \[/u);
        expect(registration).toMatch(/defineVerticalRuntimeRegistration/u);
        expect(registration).toMatch(/generated-module-registration-workers/u);
        expect(registration).not.toMatch(/handler|migration|route/u);
        const packageJson = decodeModulePackage(
          yield* Effect.promise(() => readFile(path.join(root, PROPERTY_PACKAGE_PATH), 'utf-8')),
        );
        expect(packageJson.dependencies).toEqual({
          '@app/core-runtime': 'workspace:*',
          zeta: '1.0.0',
        });
        expect(packageJson.exports).toEqual({ '.': './src/index.ts' });
        expect(packageJson.scripts['existing']).toBe('preserve-me');
        expect(packageJson.scripts['build'] ?? '').toMatch(
          /--vertical property-registry --target dist/u,
        );
        expect(packageJson.scripts['cloudflare:build'] ?? '').toMatch(
          /--vertical property-registry --target cloudflare-dist/u,
        );
        expect(packageJson.modernjs.ontosModule).toEqual({
          contractPath: '/.well-known/ontos-module-manifest.json',
          manifest: './vertical.manifest.ts',
          moduleId: MODULE_ID,
          registration: './vertical.registration.ts',
          schemaVersion: 2,
        });
        const tsconfig = Schema.decodeUnknownSync(ModuleTsconfigSchema)(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(path.join(root, 'verticals/property-registry/tsconfig.json'), 'utf-8'),
            ),
          ),
        );
        expect(tsconfig.include).toEqual([
          'src',
          'shared',
          'vertical.manifest.ts',
          'vertical.registration.ts',
        ]);
      }),
    );
  }),
);

it.live(
  'emits deterministic deployment-safe JSON and rejects damaged owner slots',
  Effect.fn(function* scenario13() {
    yield* withFixture(
      Effect.fn(function* scenario14(root) {
        yield* scaffold(root);
        yield* scaffold(root, DOCUMENTS_APP_ID, DOCUMENTS_MODULE_ID);
        const authoredManifestPath = path.join(root, PROPERTY_MANIFEST_PATH);
        const authoredManifest = yield* Effect.promise(() =>
          readFile(authoredManifestPath, 'utf-8'),
        );
        yield* Effect.promise(() =>
          writeFile(
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
          ),
        );
        const first = yield* generateOntosModuleContract({
          target: 'dist',
          vertical: APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer));
        const firstContent = yield* Effect.promise(() => readFile(first.path, 'utf-8'));
        const packagePath = path.join(root, PROPERTY_PACKAGE_PATH);
        const packageContent = yield* Effect.promise(() => readFile(packagePath, 'utf-8'));
        const decodedPackage = decodeModulePackage(packageContent);
        const incompatiblePackage = {
          ...decodedPackage,
          modernjs: {
            ...decodedPackage.modernjs,
            ontosModule: { ...decodedPackage.modernjs.ontosModule, schemaVersion: 0 },
          },
        };
        yield* Effect.promise(() => writeFile(packagePath, json(incompatiblePackage), 'utf-8'));
        yield* expectFailure(
          generateOntosModuleContract({
            target: 'dist',
            vertical: APP_ID,
            workspaceRoot: root,
          }).pipe(Effect.provide(NodeServices.layer)),
          (error) => expect(String(error)).toMatch(/module marker does not match/u),
        );
        expect(yield* Effect.promise(() => readFile(first.path, 'utf-8'))).toBe(firstContent);
        yield* Effect.promise(() => writeFile(packagePath, packageContent, 'utf-8'));
        const second = yield* generateOntosModuleContract({
          target: 'dist',
          vertical: APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer));
        expect(yield* Effect.promise(() => readFile(second.path, 'utf-8'))).toBe(firstContent);
        expect(second.etag).toBe(first.etag);
        const document = decodeModuleContract(firstContent);
        expect(document.deployment.appId).toBe(APP_ID);
        expect(document.manifest.module.id).toBe(MODULE_ID);
        expect(document.schemaVersion).toBe('2');
        expect(Object.hasOwn(document.manifest, 'dependencies')).toBe(false);
        expect(document.manifest.publicSurface.api[0]?.operationKeys).toEqual([
          'property.listUnits',
        ]);
        expect(firstContent).not.toMatch(/vertical\.registration|function|handler|sourcePath/u);
        const headers = yield* Effect.promise(() =>
          readFile(path.join(root, 'verticals/property-registry/dist/public/_headers'), 'utf-8'),
        );
        expect(headers).toMatch(/Cache-Control: no-cache/u);
        expect(headers).toMatch(/Content-Type: application\/json/u);
        expect(headers).toMatch(/ETag: "[a-f0-9]{64}"/u);
        const secondDeployment = yield* generateOntosModuleContract({
          target: 'dist',
          vertical: DOCUMENTS_APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer));
        const secondDocument = decodeModuleContract(
          yield* Effect.promise(() => readFile(secondDeployment.path, 'utf-8')),
        );
        expect(secondDocument.deployment.appId).toBe(DOCUMENTS_APP_ID);
        expect(secondDocument.manifest.module.id).toBe(DOCUMENTS_MODULE_ID);

        const manifestPath = path.join(root, PROPERTY_MANIFEST_PATH);
        const manifest = yield* Effect.promise(() => readFile(manifestPath, 'utf-8'));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            manifest.replace('// </generated-module-manifest-actions>', ''),
            'utf-8',
          ),
        );
        yield* expectFailure(
          generateOntosModuleContract({
            target: 'dist',
            vertical: APP_ID,
            workspaceRoot: root,
          }).pipe(Effect.provide(NodeServices.layer)),
          (error) => expect(String(error)).toMatch(/exactly one.*slot/u),
        );
      }),
    );
  }),
);

it.live(
  'maps Cloudflare emission to the Modern output root and validates authored contracts',
  Effect.fn(function* scenario15() {
    yield* withFixture(
      Effect.fn(function* scenario16(root) {
        yield* scaffold(root);
        yield* scaffold(root, DOCUMENTS_APP_ID, DOCUMENTS_MODULE_ID);
        const emitted = yield* generateOntosModuleContract({
          target: 'cloudflare-dist',
          vertical: APP_ID,
          workspaceRoot: root,
        }).pipe(Effect.provide(NodeServices.layer));
        expect(emitted.path).toMatch(
          /verticals\/property-registry\/dist-cloudflare\/public\/\.well-known\/ontos-module-manifest\.json$/u,
        );
        yield* checkOntosModuleContracts(root).pipe(Effect.provide(NodeServices.layer));
      }),
    );
  }),
);

it('permits owner-local registration imports but rejects cross-deployment owner imports', () => {
  const root = '/workspace/app';
  expect(
    privateOwnerImportViolation(
      root,
      'verticals/billing/src/worker-host/main.ts',
      '../../vertical.registration.ts',
    ),
  ).toBe(undefined);
  expect(
    privateOwnerImportViolation(
      root,
      'verticals/billing/src/worker-host/main.ts',
      '../../../inventory-stock/vertical.registration.ts',
    ) ?? '',
  ).toMatch(/only its own/u);
  expect(
    privateOwnerImportViolation(
      root,
      'verticals/billing/vertical.registration.ts',
      '../inventory-stock/vertical.registration.ts',
    ) ?? '',
  ).toMatch(/only its own/u);
  expect(
    privateOwnerImportViolation(
      root,
      'apps/shell-super-app/api/index.ts',
      '../../../verticals/billing/vertical.registration.ts',
    ) ?? '',
  ).toMatch(/may not import/u);
});
