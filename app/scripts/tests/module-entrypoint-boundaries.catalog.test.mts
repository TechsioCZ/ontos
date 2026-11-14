import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasValidGovernedHttpCompositionRoot,
  hasValidGovernedHttpCompositionRootStaged,
  hasGeneratedActionHttpRunnerBinding,
  hasOwnerLocalReadServiceFactory,
} from '../generated-governed-http-boundary.mts';
import {
  CATALOG_VERTICAL_PATH,
  CORE_RUNTIME_SOURCE_IMPORT,
  PRICING_HANDLER_PATH,
  PRICING_SHARED_API_PATH,
  readPricingSourceTree,
} from './module-entrypoint-boundaries.fixture.mts';

for (const owner of [CATALOG_VERTICAL_PATH]) {
  it.live(`proves the full native operationContracts array for ${owner}, independent of marker placement`, () =>
    Effect.gen(function* nativeOwnerOperationInventory() {
      const root = path.resolve(import.meta.dirname, '../..');
      const trees = yield* Effect.all(
        [`${owner}/api`, `${owner}/shared`, `${owner}/src`, 'packages'].map((folder) =>
          Effect.promise(() => readPricingSourceTree(root, folder)),
        ),
      );
      const runtimeDeclarationFile = `${owner}/vertical.runtime-declaration.ts`;
      const hasRuntimeDeclaration = yield* Effect.promise(() =>
        readFile(path.join(root, runtimeDeclarationFile), 'utf-8').then(
          () => true,
          () => false,
        ),
      );
      const metadata = yield* Effect.all(
        [
          `${owner}/package.json`,
          `${owner}/vertical.manifest.ts`,
          `${owner}/vertical.registration.ts`,
          ...(hasRuntimeDeclaration ? [runtimeDeclarationFile] : []),
        ].map((file) =>
          Effect.promise(() => readFile(path.join(root, file), 'utf-8')).pipe(
            Effect.map((source) => [file, source] as const),
          ),
        ),
      );
      const sources = new Map([...trees.flat(), ...metadata]);
      const start = '// <generated-module-manifest-operation-contracts>';
      const end = '// </generated-module-manifest-operation-contracts>';
      // A runtime declaration split (as in main's Party Registry) carries the operation contracts instead of the manifest.
      const manifestFile = (sources.get(`${owner}/vertical.manifest.ts`) ?? '').includes(start)
        ? `${owner}/vertical.manifest.ts`
        : runtimeDeclarationFile;
      const manifest = sources.get(manifestFile) ?? '';
      const begin = manifest.indexOf(start);
      const finish = manifest.indexOf(end);
      expect(begin).toBeGreaterThan(0);
      expect(finish).toBeGreaterThan(begin);
      const claims = manifest.slice(begin + start.length, finish);
      const outside = `${manifest.slice(0, begin)}${claims}${start}\n${manifest.slice(finish)}`;
      const deployment = path.posix.basename(owner);
      const diagnostics: string[] = [];
      const accepts = (source: string, sink?: string[]) =>
        hasCompleteGeneratedModuleApiSeam(
          new Map([...sources, [manifestFile, source]]),
          `${owner}/shared/api.ts`,
          deployment,
          sink,
        );
      expect(accepts(manifest, diagnostics), diagnostics.join('\n')).toBe(true);
      expect(accepts(outside)).toBe(true);
      const detached = manifest.slice(0, begin + start.length) + manifest.slice(finish);
      expect(accepts(`${detached}\nconst detachedContracts = [${claims}];`)).toBe(false);
      expect(accepts(outside.replace('operationContracts: [', 'unboundContracts: ['))).toBe(false);
      expect(accepts(outside.replace(/apiKey: '[^']+'/u, "apiKey: 'unpublished-operation'"))).toBe(false);
      expect(accepts(outside.replace('operationContracts: [', 'operationContracts: [{ ...foreignClaim },'))).toBe(
        false,
      );
      expect(accepts(manifest.replaceAll(CORE_RUNTIME_SOURCE_IMPORT, "from './counterfeit-core.ts'"))).toBe(false);
      const runtimeManifestName = `${deployment.replaceAll(/-(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase())}RuntimeManifest`;
      const duplicateRoot =
        manifestFile === runtimeDeclarationFile
          ? `${manifest}\nexport const ${runtimeManifestName} = { publicSurface: { operationContracts: [] } };`
          : `${manifest}\nexport const detachedManifest = defineOntosModuleManifest({ publicSurface: { operationContracts: [] } });`;
      expect(accepts(duplicateRoot)).toBe(false);
    }),
  );
}

it.live('binds actual governed Action HTTP runners across formatting and an authenticated observer', () =>
  Effect.gen(function* actualActionRunnerBinding() {
    const root = path.resolve(import.meta.dirname, '../..');
    for (const [slug, layer] of [
      ['execute-symmy-retention', 'executeSymmyRetentionActionApiLive'],
      ['admit-symmy-sync', 'admitSymmySyncActionApiLive'],
    ] as const) {
      const source = yield* Effect.promise(() =>
        readFile(path.join(root, `verticals/symmy-integration/api/${slug}-action-server.ts`), 'utf-8'),
      );
      expect(hasGeneratedActionHttpRunnerBinding(source, layer), slug).toBe(true);
      expect(
        hasGeneratedActionHttpRunnerBinding(source.replace('bindActionHttpRunner(', 'bindActionHttpRunner(\n'), layer),
      ).toBe(true);
      for (const [name, invalid] of [
        ['foreign runner', source.replace("from './action-http-runner.ts'", "from './foreign-runner.ts'")],
        ['detached endpoint', source.replace('=> execute(payload, request)', '=> detached(payload, request)')],
        ['foreign Effect', source.replace("from '@modern-js/bff-effect/effect-edge'", "from './foreign-edge.ts'")],
        [
          'dead native runner',
          `${source.replace(
            'const runActionHttp = bindActionHttpRunner(',
            'const unusedActionRunner = bindActionHttpRunner(',
          )}\nfunction decoy() { const runActionHttp = () => undefined; }`,
        ],
        ['duplicate runner binding', `${source}\nconst runActionHttp = bindActionHttpRunner({});`],
        [
          'unexported group with comment decoy',
          `${source.replace('export const '.concat(layer), 'const '.concat(layer))}\n// export const ${layer} = HttpApiBuilder.group(`,
        ],
        ['optional output chain', source.replace(').pipe(Layer.provide(', ')?.pipe(Layer.provide(')],
        ['escaped runner', `${source}\nconsume(runActionHttp);`],
        ['mutated imported runner', `${source}\nbindActionHttpRunner = replacement;`],
        [
          'shadowed endpoint',
          source.replace('({ payload, request }) => execute', '({ payload, request, execute }) => execute'),
        ],
      ] as const) {
        expect(invalid, name).not.toBe(source);
        expect(hasGeneratedActionHttpRunnerBinding(invalid, layer), name).toBe(false);
      }
    }
  }),
);

it.live('recognizes the actual Core ReadServiceFactory operational-scope parameter without forged utility types', () =>
  Effect.gen(function* actualCatalogScopedFactory() {
    const root = path.resolve(import.meta.dirname, '../..');
    const owner = CATALOG_VERTICAL_PATH;
    const readFileName = `${owner}/src/api/catalog-source-products.read.ts`;
    const factoryFile = `${owner}/src/persistence/catalog-source-correlation.ts`;
    const read = yield* Effect.promise(() => readFile(path.join(root, readFileName), 'utf-8'));
    const factory = yield* Effect.promise(() => readFile(path.join(root, factoryFile), 'utf-8'));
    const accepts = (source: string) =>
      hasOwnerLocalReadServiceFactory(
        new Map([
          [readFileName, read],
          [factoryFile, source],
        ]),
        readFileName,
        owner,
        'catalogSourceProductsForScope',
      );
    expect(accepts(factory)).toBe(true);
    const actual = 'scope: Parameters<ReadServiceFactory<void>>[1]';
    for (const invalid of [
      factory.replace(actual, 'scope: Parameters<ReadServiceFactory<void>>[0]'),
      factory.replace(actual, 'scope: Parameters<ForeignFactory<void>>[1]'),
      factory.replace(actual, 'scope: Parameters<ReadServiceFactory<void>>[2]'),
      `${factory}\ntype Parameters<T> = [never, OperationalScope];`,
      factory.replaceAll(CORE_RUNTIME_SOURCE_IMPORT, "from './foreign-core.ts'"),
    ]) {
      expect(invalid).not.toBe(factory);
      expect(accepts(invalid)).toBe(false);
    }
  }),
);

it.live('rejects unbound Core Read layers in generated owner HTTP roots', () =>
  Effect.gen(function* unboundOwnerReadRuntime() {
    const root = path.resolve(import.meta.dirname, '../..');
    const [shared, handler] = yield* Effect.all(
      [PRICING_SHARED_API_PATH, PRICING_HANDLER_PATH].map((file) =>
        Effect.promise(() => readFile(path.join(root, file), 'utf-8')),
      ),
    );
    expect(hasValidGovernedHttpCompositionRoot(shared, handler)).toBe(true);
    const ownerRuntime = `const readRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, pricingRegistration).pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(activeApplicationCompositionLive),
  Layer.provide(databaseIdentitiesLive),
  // Scoped owner factories execute after receiving; their Crypto requirement must stay visible in the runtime context.
  Layer.provideMerge(nodeCryptoLayer),
);`;
    expect(handler).toContain(ownerRuntime);
    const directReadImport = handler.replace('  makeReadRuntimeLive,', '  ReadRuntimeLive,');
    const direct = directReadImport.replace(
      ownerRuntime,
      'const readRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(readRuntimeDependenciesLive));',
    );
    const aliased = handler
      .replace('  makeReadRuntimeLive,', '  ReadRuntimeLive as GovernedReadRuntimeLive,')
      .replace(ownerRuntime, '')
      .replaceAll('readRuntimeDependenciesLive', 'governedReadRuntimeDependenciesLive')
      .replace(
        'const governedReadRuntimeLive = readRuntimeLive;',
        'const governedReadRuntimeLive = GovernedReadRuntimeLive.pipe(GovernedReadLayer.provide(governedReadRuntimeDependenciesLive));',
      );
    // Demo identity enrolment (the owner's databaseIdentitiesLive) is not a Core Read layer binding: providing it
    // beside a direct Core Read layer never makes that layer owner-bound.
    const directWithEnrollment = directReadImport.replace(
      ownerRuntime,
      'const readRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(readRuntimeDependenciesLive), Layer.provide(databaseIdentitiesLive));',
    );
    for (const invalid of [direct, aliased, directWithEnrollment]) {
      expect(invalid).not.toBe(handler);
      expect(hasValidGovernedHttpCompositionRoot(shared, invalid)).toBe(false);
    }
  }),
);

it.live('pins the database identity enrolment provided to an owner Read runtime to its exact Core form', () =>
  Effect.gen(function* pinnedDatabaseIdentityEnrollment() {
    const root = path.resolve(import.meta.dirname, '../..');
    const [shared, handler] = yield* Effect.all(
      [PRICING_SHARED_API_PATH, PRICING_HANDLER_PATH].map((file) =>
        Effect.promise(() => readFile(path.join(root, file), 'utf-8')),
      ),
    );
    const accepts = (source: string) =>
      hasValidGovernedHttpCompositionRoot(shared, source) && hasValidGovernedHttpCompositionRootStaged(shared, source);
    const enrollment =
      'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));';
    const coreImport = '  makeDatabaseIdentityEnrollmentLive,\n';
    const ownerImport = "import { pricingRegistration } from '../vertical.registration.ts';";
    expect(handler).toContain(enrollment);
    expect(handler).toContain(coreImport);
    expect(accepts(handler)).toBe(true);
    const withEnrollment = (source: string, value: string) => source.replace(enrollment, value);
    const ownerDescriptor = withEnrollment(
      handler.replace(
        ownerImport,
        `${ownerImport}\nimport { PRICING_DATABASE_IDENTITY_DESCRIPTOR } from '../src/database-identity.ts';`,
      ),
      'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(\n  defineDatabaseIdentityEnrollment([PRICING_DATABASE_IDENTITY_DESCRIPTOR]),\n);',
    );
    expect(accepts(ownerDescriptor)).toBe(true);
    const coreRead = withEnrollment(
      handler.replace(coreImport, `${coreImport}  ReadRuntimeLive,\n`),
      'const databaseIdentitiesLive = ReadRuntimeLive.pipe(Layer.provide(DatabaseConfigLive));',
    );
    const foreignFactory = handler
      .replace(coreImport, '')
      .replace(
        ownerImport,
        `${ownerImport}\nimport { makeDatabaseIdentityEnrollmentLive } from './foreign-enrollment.ts';`,
      );
    const localLookAlike = handler
      .replace(coreImport, '')
      .replace(
        enrollment,
        `const makeDatabaseIdentityEnrollmentLive = (_: unknown) => ReadRuntimeLive;\n${enrollment}`,
      );
    for (const [name, invalid] of [
      ['Core Read layer under the enrolment name', coreRead],
      ['foreign look-alike enrolment factory', foreignFactory],
      ['local look-alike enrolment factory', localLookAlike],
      [
        'extra pipe on the enrolment',
        withEnrollment(
          handler,
          'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])).pipe(Layer.provideMerge(DatabaseConfigLive));',
        ),
      ],
      ['reassigned enrolment', `${handler}\ndatabaseIdentitiesLive = DatabaseConfigLive;`],
      [
        'mutable enrolment',
        withEnrollment(
          handler,
          'let databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));',
        ),
      ],
      [
        'shadowing enrolment',
        `${handler}\nfunction decoy() { const databaseIdentitiesLive = DatabaseConfigLive; return databaseIdentitiesLive; }`,
      ],
      [
        'foreign descriptor',
        withEnrollment(
          handler.replace(
            ownerImport,
            `${ownerImport}\nimport { CRM_DATABASE_IDENTITY_DESCRIPTOR } from '../../crm/src/database-identity.ts';`,
          ),
          'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([CRM_DATABASE_IDENTITY_DESCRIPTOR]));',
        ),
      ],
      [
        'computed descriptor',
        withEnrollment(
          handler,
          'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([...descriptors]));',
        ),
      ],
      [
        'enrolment through a variable',
        withEnrollment(
          handler,
          'const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(enrollment);\nconst enrollment = defineDatabaseIdentityEnrollment([]);',
        ),
      ],
    ] as const) {
      expect(invalid, name).not.toBe(handler);
      expect(hasValidGovernedHttpCompositionRoot(shared, invalid), name).toBe(false);
      expect(hasValidGovernedHttpCompositionRootStaged(shared, invalid), name).toBe(false);
    }
  }),
);
