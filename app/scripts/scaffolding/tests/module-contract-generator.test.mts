import { write } from './fixture-files.mts';
import { linkFixtureDependencies, withCreatedFixture } from './fixture-ownership.mts';
import { Cause, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { NodeServices } from '@effect/platform-node';

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  privateOwnerImportViolation,
  unconstrainedHttpApiContractSchemaViolation,
} from '../../ultramodern-api-boundary-rules.mts';
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
  Schema.decodeUnknownEffect(ModulePackageSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );
const decodeModuleContract = (source: string) =>
  Schema.decodeUnknownEffect(ModuleContractDocumentSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

const writePinnedEffectApi = (root: string, slug: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* mergedScenario1() {
    yield* write(
      root,
      `verticals/${slug}/shared/api.ts`,
      `export const fixtureApi = HttpApi.make('FixtureApi').add(HttpApiGroup.make('fixture'));\n`,
    );
    yield* write(
      root,
      `verticals/${slug}/api/index.ts`,
      `const fixtureLayer = HttpApiBuilder.group(fixtureApi, 'fixture', handlers => handlers);
const layer = HttpApiBuilder.layer(fixtureApi).pipe(
  Layer.provide(fixtureLayer),
) satisfies EffectRuntimeLayer;
export default defineEffectBff({ api: fixtureApi, layer });
`,
    );
  });

const createFixture = (): Effect.Effect<string, unknown> =>
  Effect.gen(function* mergedScenario2() {
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
    yield* Effect.all(
      [writePinnedEffectApi(root, APP_ID), writePinnedEffectApi(root, DOCUMENTS_APP_ID)],
      { concurrency: 'unbounded' },
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
    yield* linkFixtureDependencies(root, appRoot, {
      '@app/core-runtime': 'packages/core-runtime',
      effect: 'node_modules/effect',
    });
    return root;
  });

const withFixture = withCreatedFixture(createFixture());

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
        const packageJson = yield* decodeModulePackage(
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
        const tsconfig = yield* Schema.decodeUnknownEffect(ModuleTsconfigSchema)(
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
        const decodedPackage = yield* decodeModulePackage(packageContent);
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
        const document = yield* decodeModuleContract(firstContent);
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
        const secondDocument = yield* decodeModuleContract(
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

it.live(
  'module-contract ignores non-code roots and nested semicolons when inserting API slots',
  Effect.fn(function* mergedScenario5() {
    yield* withFixture(
      Effect.fn(function* mergedScenario4(root) {
        const source = `// export const commentApi = HttpApi.make('Comment');
const example = "export const stringApi = HttpApi.make('String');";
export const fixtureApi = HttpApi.make('Fixture;Api')
  /* semicolon ; before the end of the expression */
  .pipe((api) => { const label = ';'; return api; });
export const untouched = true;
`;
        yield* write(root, 'verticals/property-registry/shared/api.ts', source);
        yield* scaffold(root);
        const generated = yield* Effect.promise(() =>
          readFile(path.join(root, 'verticals/property-registry/shared/api.ts'), 'utf-8'),
        );
        expect(generated).toMatch(/HttpApi\.make\('Fixture;Api'\)/u);
        expect(generated).toMatch(
          /return api; \}\)\s*\/\/ <generated-governed-http-api-additions>/u,
        );
        expect(generated).toMatch(/export const governedHttpApi = fixtureApi;/u);
        expect(generated).toMatch(/export const untouched = true;/u);
      }),
    );
  }),
);

it.live(
  'module-contract injects only its own Layer binding into pinned handler roots',
  Effect.fn(function* mergedScenario8() {
    yield* withFixture(
      Effect.fn(function* mergedScenario7(root) {
        yield* write(
          root,
          'verticals/property-registry/api/index.ts',
          `const layer = HttpApiBuilder.layer(fixtureApi).pipe(
  identity,
) satisfies EffectRuntimeLayer;
export default defineEffectBff({ api: fixtureApi, layer });
`,
        );
        yield* scaffold(root);
        const generated = yield* Effect.promise(() =>
          readFile(path.join(root, 'verticals/property-registry/api/index.ts'), 'utf-8'),
        );
        expect(generated).toMatch(/GovernedReadLayer\.provide\(governedReadApiHandlersLive\)/u);
        expect(generated).toMatch(/GovernedReadLayer\.orDie/u);
        expect(generated).not.toMatch(/\bLayer\./u);
      }),
    );
  }),
);

it('requires concrete HttpApi contract schemas through Problem Details helpers', () => {
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        field: Schema.String,
      });
    `),
  ).toBe(undefined);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        field: Schema.Unknown,
      });
    `) ?? '',
  ).toMatch(/must use concrete/u);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      HttpApiEndpoint.post('execute', '/reads/example', {
        success: Schema.Any,
      });
    `) ?? '',
  ).toMatch(/must use concrete/u);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        diagnostics: Schema.Record(Schema.String, Schema.String),
      });
    `) ?? '',
  ).toMatch(/must use concrete/u);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
        diagnostics: Schema.Json,
      });
    `) ?? '',
  ).toMatch(/must use concrete/u);
});

const contractApiFixturePath = 'contracts/api.ts';
const contractBarrelFixturePath = 'contracts/barrel.ts';
const unsafeContractFixturePath = 'contracts/unsafe.ts';
const packageFixturePath = 'packages/example/package.json';
const packageSafeFixturePath = 'packages/example/src/safe.ts';
const packageUnsafeFixturePath = 'packages/example/src/unsafe.ts';
const packageSafeSchemaFixture = `export const UnsafeSchema = Schema.String;`;

it('follows imported payload, query, parameter, success, and error schemas', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
      member,
    ).toMatch(/must use concrete/u);
  }
});

it('covers every supported endpoint constructor through direct and aliased paths', () => {
  for (const method of ['delete', 'head', 'options']) {
    expect(
      unconstrainedHttpApiContractSchemaViolation(`
        HttpApiEndpoint.${method}('execute', '/reads/example', { success: Schema.Any });
      `) ?? '',
      method,
    ).toMatch(/must use concrete/u);
  }

  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const inspectHeaders = HttpApiEndpoint.head;
      inspectHeaders('execute', '/reads/example', { success: Schema.Unknown });
    `) ?? '',
  ).toMatch(/must use concrete/u);

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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows HttpApiEndpoint.make factories through local and imported helpers', () => {
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
    expect(unconstrainedHttpApiContractSchemaViolation(source) ?? '').toMatch(/must use concrete/u);
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows the direct HttpApiEndpoint provider through verbs, make, and re-exports', () => {
  const provider = 'effect/unstable/httpapi/HttpApiEndpoint';
  for (const method of ['delete', 'get', 'head', 'options', 'patch', 'post', 'put']) {
    const entry = `
      import * as Endpoint from '${provider}';
      Endpoint.${method}('execute', '/reads/example', { success: Schema.Any });
    `;
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources: new Map([[contractApiFixturePath, entry]]),
      }) ?? '',
      method,
    ).toMatch(/must use concrete/u);
  }

  const makeEntry = `
    import * as Endpoint from './barrel';
    Endpoint.make('GET')('execute', '/reads/example', { success: Schema.Unknown });
  `;
  const makeSources = new Map([
    [contractApiFixturePath, makeEntry],
    [contractBarrelFixturePath, `export * from '${provider}';`],
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(makeEntry, {
      file: contractApiFixturePath,
      sources: makeSources,
    }) ?? '',
  ).toMatch(/must use concrete/u);

  const namespaceEntry = `
    import { Endpoint } from './barrel';
    Endpoint.get('execute', '/reads/example', { success: Schema.Any });
  `;
  const namespaceSources = new Map([
    [contractApiFixturePath, namespaceEntry],
    [contractBarrelFixturePath, `export * as Endpoint from '${provider}';`],
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(namespaceEntry, {
      file: contractApiFixturePath,
      sources: namespaceSources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows local and imported function helpers used as public schemas', () => {
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      function unsafeResponse() {
        return Schema.Any;
      }
      HttpApiEndpoint.get('read', '/reads/example', { success: unsafeResponse() });
    `) ?? '',
  ).toMatch(/must use concrete/u);

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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows imported arbitrary Problem Details extension records', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows transitive imported schema aliases without rejecting unused unsafe exports', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);

  const safeSources = new Map([
    ...sources,
    [
      'contracts/internal-response.ts',
      `export const InternalResponse = Schema.Struct({ value: Schema.String });`,
    ] as const,
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(safeSources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
  ).toBe(undefined);
});

it('rejects Effect Schema namespace aliases and destructured unsafe members', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('follows barrel re-exports and relative namespace imports', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('follows local re-exports of imported schemas', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('rejects direct Effect schema imports used through an aliased endpoint factory', () => {
  const content = `
    import { HttpApiEndpoint as Endpoint } from '@modern-js/plugin-bff/effect-client';
    import { Any as UnsafeSchema } from 'effect';
    Endpoint.get('read', '/reads/example', { success: UnsafeSchema });
  `;
  expect(unconstrainedHttpApiContractSchemaViolation(content) ?? '').toMatch(/must use concrete/u);
});

it('follows schemas imported through @app package subpaths', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('follows star barrels, default imports, and package export maps', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('covers ordinary endpoint aliases and TypeScript module forms', () => {
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
    expect(unconstrainedHttpApiContractSchemaViolation(content) ?? '').toMatch(
      /must use concrete/u,
    );
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('covers destructured, computed, and provenance-safe aliases', () => {
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
    expect(unconstrainedHttpApiContractSchemaViolation(content) ?? '').toMatch(
      /must use concrete/u,
    );
  }

  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const Schema = { Any: 'not an Effect schema' };
      const HttpApiEndpoint = { get: () => undefined };
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
      const makeProblemDetailsSchema = () => undefined;
      makeProblemDetailsSchema('SafeLocalCall', 400, { value: Schema.Any });
    `),
  ).toBe(undefined);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      HttpApiEndpoint.get('read', '/reads/example', {
        success: Schema.Record(Schema.String, Schema.String),
      });
    `),
  ).toBe(undefined);
});

it('resolves recursive namespace exports for endpoints, factories, and schemas', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('resolves lexical shadows without inspecting unused inner bindings', () => {
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const ResponseSchema = Schema.Any;
      { const ResponseSchema = Schema.String; void ResponseSchema; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `) ?? '',
  ).toMatch(/must use concrete/u);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const ResponseSchema = Schema.String;
      { const ResponseSchema = Schema.Any; void ResponseSchema; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `),
  ).toBe(undefined);
});

it('evaluates package export conditions, wildcard specificity, and null exclusions', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(safeEntry, {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
  ).toBe(undefined);

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
  expect(
    unconstrainedHttpApiContractSchemaViolation(specificEntry, {
      file: contractApiFixturePath,
      sources: specificSources,
    }),
  ).toBe(undefined);
});

it('terminates on safe and unsafe cyclic re-exports', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: safeSources,
    }),
  ).toBe(undefined);
  const unsafeSources = new Map([
    ...safeSources,
    [
      'contracts/cycle-b.ts',
      `export * from './cycle-a'; export const ResponseSchema = Schema.Any;`,
    ] as const,
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: unsafeSources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('honors explicit export precedence and star-export binding identity', () => {
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
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: explicitSources,
    }),
  ).toBe(undefined);

  const diamondSources = new Map([
    [contractApiFixturePath, entry],
    [contractBarrelFixturePath, `export * from './left'; export * from './right';`],
    ['contracts/left.ts', `export * from './origin';`],
    ['contracts/right.ts', `export * from './origin';`],
    ['contracts/origin.ts', `export const ResponseSchema = Schema.Unknown;`],
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: diamondSources,
    }) ?? '',
  ).toMatch(/must use concrete/u);

  const ambiguousSources = new Map([
    ...diamondSources,
    ['contracts/left.ts', `export const ResponseSchema = Schema.String;`] as const,
    ['contracts/right.ts', `export const ResponseSchema = Schema.Any;`] as const,
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources: ambiguousSources,
    }),
  ).toBe(undefined);
});

it('uses TypeScript source and relative-file resolution precedence', () => {
  const entry = `
    import { ResponseSchema } from './foo';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const sources = new Map([
    [contractApiFixturePath, entry],
    ['contracts/foo.ts', `export const ResponseSchema = Schema.String;`],
    ['contracts/foo/index.ts', `export const ResponseSchema = Schema.Any;`],
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(entry, {
      file: contractApiFixturePath,
      sources,
    }),
  ).toBe(undefined);

  const nodeNextEntry = `
    import { ResponseSchema } from './foo.js';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `;
  const nodeNextSources = new Map([
    ...sources,
    [contractApiFixturePath, nodeNextEntry] as const,
    ['contracts/foo.ts', `export const ResponseSchema = Schema.Json;`] as const,
  ]);
  expect(
    unconstrainedHttpApiContractSchemaViolation(nodeNextEntry, {
      file: contractApiFixturePath,
      sources: nodeNextSources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
});

it('tracks object, mutable, rest, var, enum, and namespace provenance', () => {
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
    expect(unconstrainedHttpApiContractSchemaViolation(content) ?? '').toMatch(
      /must use concrete/u,
    );
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
    expect(unconstrainedHttpApiContractSchemaViolation(content)).toBe(undefined);
  }
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const { String, ...S } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.String });
    `),
  ).toBe(undefined);
});

it('follows external schema and endpoint provider re-exports', () => {
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(entry, {
        file: contractApiFixturePath,
        sources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
  }
});

it('follows local and imported aliases of Problem Details factories', () => {
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const factory = makeProblemDetailsSchema;
      const InvalidProblem = factory('InvalidProblem', 400, { field: Schema.Unknown });
    `) ?? '',
  ).toMatch(/must use concrete/u);
  expect(
    unconstrainedHttpApiContractSchemaViolation(`
      const factory = makeProblemDetailsSchema;
      const ValidProblem = factory('ValidProblem', 400, { field: Schema.String });
    `),
  ).toBe(undefined);

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
  expect(
    unconstrainedHttpApiContractSchemaViolation(sources.get(contractApiFixturePath) ?? '', {
      file: contractApiFixturePath,
      sources,
    }) ?? '',
  ).toMatch(/must use concrete/u);
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
    expect(
      unconstrainedHttpApiContractSchemaViolation(inlineSources.get(contractApiFixturePath) ?? '', {
        file: contractApiFixturePath,
        sources: inlineSources,
      }) ?? '',
    ).toMatch(/must use concrete/u);
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
      expect(
        unconstrainedHttpApiContractSchemaViolation(entry, {
          file: contractApiFixturePath,
          sources: aliasedSources,
        }) ?? '',
      ).toMatch(/must use concrete/u);
    }
  }
});
