import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getHelpText, runScaffoldEffect } from '../cli.mts';
import { snapshotTree, write } from './fixture-files.mts';
import { linkFixtureDependencies, withCreatedFixture } from './fixture-ownership.mts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');
const command = 'label-head';
const verticalFlag = '--vertical';
const nameFlag = '--name';
const verticalName = 'property-registry';
const moduleId = 'property.registry';
const labelHeadName = 'rental-unit';
const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const verticalRoot = `verticals/${verticalName}`;
const generatedPaths = {
  contract: `${verticalRoot}/shared/labels/${labelHeadName}.ts`,
  migration: `${verticalRoot}/src/database/${labelHeadName}-label-head.migration.ts`,
  schema: `${verticalRoot}/src/database/${labelHeadName}-label-head.ts`,
  service: `${verticalRoot}/src/services/${labelHeadName}-label-head.service.ts`,
  verifier: `${verticalRoot}/scripts/verify-${labelHeadName}-label-head.mts`,
} as const;

type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

const generatedContractSchema = Schema.Struct({
  RentalUnitLabelHeadSchema: Schema.declare<Schema.Top>(Schema.isSchema),
  RentalUnitLabelReferenceSchema: Schema.declare<Schema.Top>(Schema.isSchema),
});

const createFixture = (): Effect.Effect<string, unknown> =>
  Effect.gen(function* createLabelHeadFixture() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-label-head-scaffold-')));
    yield* write(root, 'package.json', json({ name: 'fixture', private: true, type: 'module' }));
    yield* write(
      root,
      `${verticalRoot}/package.json`,
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
          build: 'modern build --deploy-target node && modern deploy --skip-build --deploy-target node',
        },
        type: 'module',
        version: '0.1.0',
      }),
    );
    yield* write(
      root,
      `${verticalRoot}/tsconfig.json`,
      json({ compilerOptions: { composite: true }, include: ['src', 'shared'], references: [] }),
    );
    yield* write(root, `${verticalRoot}/module-federation.config.ts`, 'export default { exposes: {} };\n');
    yield* write(
      root,
      `${verticalRoot}/shared/api.ts`,
      `import { HttpApi } from 'effect/http-api';

export const propertyRegistryApi = HttpApi.make('PropertyRegistryApi');
`,
    );
    yield* write(
      root,
      `${verticalRoot}/api/index.ts`,
      `import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Layer } from '@modern-js/bff-effect/effect-edge';
import { propertyRegistryApi } from '../shared/api.ts';

const handlersLive = Layer.empty;

export default assembleEffectBffRuntime({ api: propertyRegistryApi, handlers: handlersLive });
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
            moduleFederation: { name: 'verticalPropertyRegistry', role: 'remote' },
            package: '@app/property-registry',
            path: verticalRoot,
          },
        ],
      }),
    );
    yield* write(
      root,
      'types/core-runtime.d.ts',
      `import type { Schema } from 'effect';

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

const scaffoldLabelHead = Effect.fn(function* scaffoldLabelHead(root: string, name = labelHeadName) {
  return yield* runScaffoldEffect(command, [verticalFlag, verticalName, nameFlag, name], {
    workspaceRoot: root,
  }).pipe(Effect.provide(NodeServices.layer));
});

const readGenerated = (root: string, relativePath: string) =>
  Effect.promise(() => readFile(path.join(root, relativePath), 'utf-8'));

/** Refusal must preserve the fixture byte-for-byte. */
const assertLabelHeadRefused = Effect.fn(function* assertLabelHeadRefused(
  root: string,
  expected: RegExp,
  ignored: readonly string[] = ['node_modules'],
) {
  const before = yield* snapshotTree(root, ignored);
  const cause = yield* scaffoldLabelHead(root).pipe(Effect.sandbox, Effect.flip);
  expect(String(Cause.squash(cause))).toMatch(expected);
  expect(yield* snapshotTree(root, ignored)).toEqual(before);
});

it.live(
  'label-head help documents the owner-local command and writes nothing',
  Effect.fn(function* labelHeadHelp() {
    const missingRoot = path.join(tmpdir(), 'label-head-help-does-not-exist');
    const result = yield* runScaffoldEffect(command, ['--help'], { workspaceRoot: missingRoot }).pipe(
      Effect.provide(NodeServices.layer),
    );
    expect(result).toEqual({ help: getHelpText(command), kind: 'help' });
    if (result.kind !== 'help') {
      throw new Error('Expected help result');
    }
    expect(result.help).toMatch(/scaffold:label-head -- --vertical <vertical> --name <name>/u);
    expect(result.help).toMatch(/lower-kebab-case/u);
    expect(result.help).toMatch(/available\/withdrawn/u);
  }),
);

it.live(
  'label-head scaffold publishes a retained canonical reference, monotonic publication revision and availability state',
  Effect.fn(function* labelHeadScenario() {
    yield* withFixture(
      Effect.fn(function* labelHeadFixture(root) {
        const result = yield* scaffoldLabelHead(root);
        expect(result.kind).toBe('generated');
        if (result.kind !== 'generated') {
          throw new Error('Expected generated result');
        }
        expect(result.result).toEqual({
          contractPath: path.join(root, generatedPaths.contract),
          migrationPath: path.join(root, generatedPaths.migration),
          schemaPath: path.join(root, generatedPaths.schema),
          servicePath: path.join(root, generatedPaths.service),
          verifierPath: path.join(root, generatedPaths.verifier),
        });

        const [contract, schema, migration, service, verifier] = yield* Effect.all(
          [
            readGenerated(root, generatedPaths.contract),
            readGenerated(root, generatedPaths.schema),
            readGenerated(root, generatedPaths.migration),
            readGenerated(root, generatedPaths.service),
            readGenerated(root, generatedPaths.verifier),
          ],
          { concurrency: 'unbounded' },
        );

        // Retained canonical reference, publication revision and available/withdrawn state.
        expect(contract).toMatch(/@ontos-label-head-owner property\.registry/u);
        expect(contract).toMatch(/export const RentalUnitLabelReferenceSchema = Schema\.Struct/u);
        expect(contract).toMatch(/resourceType: Schema\.Literal\('property\.registry\.rental-unit'\)/u);
        expect(contract).toMatch(/Schema\.Literals\(\['available', 'withdrawn'\]\)/u);
        expect(contract).toMatch(/publicationRevision/u);
        expect(contract).toMatch(/never the canonical source revision/u);

        // Owner-local schema and least-privilege migration starting points.
        expect(schema).toMatch(/export const defineRentalUnitLabelHeads = \(schema: PgSchema\)/u);
        expect(schema).toMatch(/tenantLegalEntityRlsPolicies\('rental_unit_label_heads'/u);
        expect(migration).toMatch(/export const rentalUnitLabelHeadMigrationStatements = \(ownerSchema: string\)/u);
        expect(migration).toMatch(/enable row level security/u);
        expect(migration).toMatch(/force row level security/u);
        expect(migration).not.toMatch(/^\s*grant /mu);
        expect(migration).not.toMatch(/alter default privileges/u);

        // Owner-local service and verifier starting points.
        expect(service).toMatch(/export const makeRentalUnitLabelHeadService/u);
        expect(service).toMatch(/publication revision must strictly increase/u);
        expect(service).toMatch(/A withdrawn label head must retain its exact canonical reference/u);
        expect(verifier).toMatch(/c\.relforcerowsecurity as forced/u);
        // The owner schema is bound as one parameter in both predicates, never interpolated into SQL.
        expect(verifier).toMatch(/n\.nspname <> \$1/u);
        expect(verifier).toMatch(/n\.nspname = \$1/u);
        expect(verifier).toMatch(/\[\s*ownerSchema\s*\],?\s*\)/u);
        expect(verifier).not.toMatch(/n\.nspname\s*(?:<>|=)\s*\$\{/u);

        const generatedModule = yield* Schema.decodeUnknownEffect(generatedContractSchema)(
          yield* Effect.promise(
            () => import(`${pathToFileURL(path.join(root, generatedPaths.contract)).href}?test=${randomUUID()}`),
          ),
        );
        const referenceSchema = Schema.make<Schema.Codec<unknown, unknown>>(
          generatedModule.RentalUnitLabelReferenceSchema.ast,
        );
        const headSchema = Schema.make<Schema.Codec<unknown, unknown>>(generatedModule.RentalUnitLabelHeadSchema.ast);
        const reference = yield* Schema.decodeUnknownEffect(referenceSchema)({
          moduleId,
          resourceId: 'unit-42',
          resourceType: 'property.registry.rental-unit',
          tenantId,
        });
        expect(reference).toEqual({
          moduleId,
          resourceId: 'unit-42',
          resourceType: 'property.registry.rental-unit',
          tenantId,
        });
        const available = yield* Schema.decodeUnknownEffect(headSchema)({
          availability: 'available',
          legalEntityId,
          publicationRevision: '7',
          reference,
          text: { searchableText: ['Unit 42'], title: 'Unit 42' },
        });
        expect(available).toMatchObject({ availability: 'available', publicationRevision: '7' });
        const withdrawn = yield* Schema.decodeUnknownEffect(headSchema)({
          availability: 'withdrawn',
          legalEntityId,
          publicationRevision: '8',
          reference,
        });
        expect(withdrawn).toMatchObject({ availability: 'withdrawn', publicationRevision: '8' });
        const availableWithoutText = yield* Schema.decodeUnknownEffect(headSchema)({
          availability: 'available',
          legalEntityId,
          publicationRevision: '9',
          reference,
        }).pipe(Effect.flip);
        expect(String(availableWithoutText)).toMatch(/requires bounded label text/u);
        const withdrawnWithText = yield* Schema.decodeUnknownEffect(headSchema)({
          availability: 'withdrawn',
          legalEntityId,
          publicationRevision: '10',
          reference,
          text: { searchableText: ['Unit 42'], title: 'Unit 42' },
        }).pipe(Effect.flip);
        expect(String(withdrawnWithText)).toMatch(/must not retain label text/u);

        // A malformed withdrawal must be rejected by the canonical head schema before any store I/O,
        // never by a BigInt defect raised from an unvalidated publication revision.
        const withdrawBlock = service.slice(service.indexOf('withdraw: (input)'));
        const strictDecode = withdrawBlock.indexOf("onExcessProperty: 'error'");
        const storeLoad = withdrawBlock.indexOf('store.load');
        expect(strictDecode).toBeGreaterThan(-1);
        expect(storeLoad).toBeGreaterThan(-1);
        expect(strictDecode).toBeLessThan(storeLoad);
        expect(withdrawBlock).toMatch(/Withdrawn label head payload is invalid/u);
        expect(withdrawBlock).not.toMatch(/BigInt\(input\.publicationRevision\)/u);

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
              paths: { '@app/core-runtime': ['./types/core-runtime.d.ts'] },
              skipLibCheck: true,
              strict: true,
              target: 'ESNext',
            },
            include: [`${verticalRoot}/shared/labels/**/*.ts`],
          }),
        );
        const compilation = spawnSync(tscPath, ['-p', fixtureTsconfig], { cwd: root, encoding: 'utf-8' });
        expect(compilation.status, `${compilation.stdout}${compilation.stderr}`).toBe(0);
      }),
    );
  }),
);

it.live(
  'label-head scaffold rejects invalid names and traversal without partial writes',
  Effect.fn(function* labelHeadRejections() {
    yield* withFixture(
      Effect.fn(function* labelHeadRejectionFixture(root) {
        for (const name of ['Bad Name', '../unsafe', 'src', 'rental--unit']) {
          const before = yield* snapshotTree(root, ['node_modules']);
          const cause = yield* scaffoldLabelHead(root, name).pipe(Effect.sandbox, Effect.flip);
          expect(String(Cause.squash(cause))).toMatch(/lower-kebab-case|canonical/u);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        }
      }),
    );
  }),
);

it.live(
  'label-head scaffold refuses overwrite and leaves no partial artifact when one target already exists',
  Effect.fn(function* labelHeadOverwrite() {
    yield* withFixture(
      Effect.fn(function* labelHeadOverwriteFixture(root) {
        yield* scaffoldLabelHead(root);
        yield* assertLabelHeadRefused(root, /refusing to overwrite existing business file/u);
      }),
    );

    yield* withFixture(
      Effect.fn(function* labelHeadPartialWriteFixture(root) {
        // Pre-create only the last target; the planner must refuse before writing any earlier file.
        yield* write(root, generatedPaths.verifier, 'export {};\n');
        const before = yield* snapshotTree(root, ['node_modules']);
        const cause = yield* scaffoldLabelHead(root).pipe(Effect.sandbox, Effect.flip);
        expect(String(Cause.squash(cause))).toMatch(/refusing to overwrite existing business file/u);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        for (const relativePath of Object.values(generatedPaths)) {
          if (relativePath === generatedPaths.verifier) {
            continue;
          }
          expect(yield* Effect.promise(() => readFile(path.join(root, relativePath), 'utf-8').catch(() => null))).toBe(
            null,
          );
        }
      }),
    );
  }),
);

it.live(
  'label-head scaffold reports malformed owner metadata through the typed channel',
  Effect.fn(function* labelHeadMalformedOwner() {
    yield* withFixture(
      Effect.fn(function* labelHeadMalformedOwnerFixture(root) {
        yield* Effect.promise(() => writeFile(path.join(root, `${verticalRoot}/package.json`), '[]', 'utf-8'));
        const before = yield* snapshotTree(root, ['node_modules']);
        const failure = yield* runScaffoldEffect(command, [verticalFlag, verticalName, nameFlag, labelHeadName], {
          workspaceRoot: root,
        }).pipe(Effect.flip, Effect.provide(NodeServices.layer));
        expect(String(failure)).toMatch(/JSON object/u);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
      }),
    );
  }),
);
