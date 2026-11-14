import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  APP_PACKAGE_LINK_DIRECTORY,
  BOUNDARY_FIXTURE_SHELL_ID,
  BOUNDARY_FIXTURE_SHELL_PATH,
  BOUNDARY_FIXTURE_TOPOLOGY,
  CATALOG_QUANTITY_CONTRACT,
  CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_VERTICAL_PATH,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_DEPLOYMENT_ID,
  PARTY_VERTICAL_PATH,
  PRIVACY_VERTICAL_PATH,
  PRIVATE_COLOCATED_CALLABLE_CASE,
  SHARED_CONTRACTS_WORKSPACE_NAME,
  SHARED_CONTRACTS_WORKSPACE_PATH,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  VERTICALS_WORKSPACE_DECLARATION,
  WORKSPACE_DEPENDENCY_VERSION,
  WORKSPACE_MANIFEST_PATH,
  checkModuleEntrypointBoundaries,
  makeActualCatalogSelectionFixture,
  makeActualCustomerContextAggregateFixture,
  makeActualMarketClientFixture,
  makeActualPartyClientFixture,
  makeActualPrivacyClientFixture,
  makeActualQuantityClientFixture,
  makeActualTaxClientFixture,
  makeFixture,
  readPricingSourceTree,
  write,
} from './module-entrypoint-boundaries.fixture.mts';

for (const [name, source, allowed] of [
  [
    'public selected operation and schemas',
    `import { PartyDetailResponseSchema, executePartyDetailWithAuthorization } from '${PARTY_API_CLIENT_SPECIFIER}';\nimport type { PartyDetailResponse } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    true,
  ],
  [
    'enrollment exact operations and erased types',
    `import { createPartyWithAuthorization, executePartyMatchWithAuthorization, recoverPartyCreateWithAuthorization } from '${PARTY_API_CLIENT_SPECIFIER}';\nimport type { createParty, executePartyMatch, recoverPartyCreate } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    true,
  ],
  [
    PRIVATE_COLOCATED_CALLABLE_CASE,
    `import { privatePartyClientCallable } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    false,
  ],
] as const) {
  it.live(`checks actual Party typed client ${name}`, () =>
    Effect.gen(function* actualPartyTypedClientPublication() {
      const root = yield* makeActualPartyClientFixture();
      const clientFile = `${PARTY_VERTICAL_PATH}/src/api/party-registry-client.ts`;
      const aggregate = yield* Effect.promise(() => readFile(path.join(root, clientFile), 'utf-8'));
      yield* write(root, clientFile, `${aggregate}\nexport const privatePartyClientCallable = () => globalThis;\n`);
      const consumer = 'apps/shell-super-app/src/party-client-consumer.ts';
      yield* write(root, consumer, source);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(clientFile);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

for (const [name, imported, allowed] of [
  ['public selected problem schema', 'PartyCommandNotFoundProblemSchema', true],
  [PRIVATE_COLOCATED_CALLABLE_CASE, 'privatePartyApiCallable', false],
] as const) {
  it.live(`checks actual Party public API ${name}`, () =>
    Effect.gen(function* actualPartyPublicApiPublication() {
      const root = yield* makeActualPartyClientFixture();
      const apiFile = `${PARTY_VERTICAL_PATH}/shared/api.ts`;
      const source = yield* Effect.promise(() => readFile(path.join(root, apiFile), 'utf-8'));
      yield* write(root, apiFile, `${source}\nexport const privatePartyApiCallable = () => globalThis;\n`);
      const consumer = 'apps/shell-super-app/src/party-api-consumer.ts';
      yield* write(root, consumer, `import { ${imported} } from '@app/party-registry/api';\n`);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(apiFile);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

it.live('checks actual Party typed client foreign API contamination', () =>
  Effect.gen(function* foreignApiInPartyDelegate() {
    const root = yield* makeActualPartyClientFixture();
    const workspace = path.resolve(import.meta.dirname, '../..');
    const privacy = yield* readPricingSourceTree(workspace, PRIVACY_VERTICAL_PATH);
    for (const [file, source] of privacy) {
      yield* write(root, file, source);
    }
    yield* write(
      root,
      BOUNDARY_FIXTURE_TOPOLOGY,
      JSON.stringify({
        shell: { id: BOUNDARY_FIXTURE_SHELL_ID, path: BOUNDARY_FIXTURE_SHELL_PATH },
        verticals: [
          { id: INVENTORY_DEPLOYMENT_ID, path: INVENTORY_VERTICAL_PATH },
          { id: PARTY_DEPLOYMENT_ID, path: PARTY_VERTICAL_PATH },
          { id: 'privacy', path: PRIVACY_VERTICAL_PATH },
        ],
      }),
    );
    yield* Effect.promise(() =>
      symlink(path.join(root, PRIVACY_VERTICAL_PATH), path.join(root, 'node_modules/@app/privacy'), 'dir'),
    );
    const delegate = `${PARTY_VERTICAL_PATH}/src/api/party-registry-http-client.ts`;
    const original = yield* Effect.promise(() => readFile(path.join(root, delegate), 'utf-8'));
    const changed = original.replace(
      "import { partyRegistryApi, partyRegistryApiContract } from '../../shared/api.ts';",
      "import { privacyApi as partyRegistryApi } from '@app/privacy/api';\nimport { partyRegistryApiContract } from '../../shared/api.ts';",
    );
    expect(changed).not.toBe(original);
    yield* write(root, delegate, changed);
    const graph = createModuleGraph();
    const binding = graph.resolve(graph.module(path.join(root, delegate)), 'partyRegistryApi', 'local');
    expect(binding?.kind).toBe('declaration');
    if (binding?.kind === 'declaration') {
      expect(binding.module.path).toBe(
        yield* Effect.promise(() => realpath(path.join(root, 'verticals/privacy/shared/api.ts'))),
      );
    }
    const consumer = 'apps/shell-super-app/src/party-client-consumer.ts';
    yield* write(
      root,
      consumer,
      `import { executePartyDetailWithAuthorization } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    );
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const diagnostic = Cause.pretty(result.cause);
      expect(diagnostic).toContain(consumer);
      expect(diagnostic).toContain(`${PARTY_VERTICAL_PATH}/src/api/party-registry-client.ts`);
    }
  }),
);

for (const [name, operation, allowed] of [
  ['public generated operation', 'executeQuantityPreparationWithAuthorization', true],
  [PRIVATE_COLOCATED_CALLABLE_CASE, 'privateQuantityClientCallable', false],
] as const) {
  for (const throughSymlink of [false, true]) {
    it.live(`checks actual quantity governed client ${name}${throughSymlink ? ' through workspace symlink' : ''}`, () =>
      Effect.gen(function* actualQuantityGovernedClient() {
        const root = yield* makeActualQuantityClientFixture();
        const file = 'verticals/catalog/src/api/quantity-preparation-client.ts';
        if (!allowed) {
          const original = yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
          yield* write(root, file, `${original}\nexport const privateQuantityClientCallable = () => globalThis;\n`);
        }
        const consumer = 'apps/shell-super-app/src/quantity-client-consumer.ts';
        yield* write(root, consumer, `import { ${operation} } from '@app/catalog/api/quantity-preparation-client';\n`);
        const checkRoot = throughSymlink ? path.join(root, 'workspace-alias') : root;
        if (throughSymlink) {
          yield* Effect.promise(() => symlink(root, checkRoot, 'dir'));
        }
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(checkRoot));
        const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
        if (Exit.isFailure(result)) {
          expect(diagnostic).toContain(consumer);
          expect(diagnostic).toContain(file);
        }
        expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
      }),
    );
  }
}

for (const [name, source, allowed] of [
  [
    'actual public owner types',
    "import type { EligibleMarketTuplesRequest, EligibleMarketTuplesResponse, ResolveCommerceMarketRequest, ResolveCommerceMarketResponse } from '@app/commerce-market-catalog/api/client';\n",
    true,
  ],
  [
    PRIVATE_COLOCATED_CALLABLE_CASE,
    "import { privateMarketClientCallable } from '@app/commerce-market-catalog/api/client';\n",
    false,
  ],
] as const) {
  it.live(`checks actual Market typed client ${name}`, () =>
    Effect.gen(function* actualMarketTypedClient() {
      const root = yield* makeActualMarketClientFixture();
      const file = 'verticals/commerce-market-catalog/src/api/commerce-market-catalog-client.ts';
      const original = yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
      yield* write(root, file, `${original}\nexport const privateMarketClientCallable = () => globalThis;\n`);
      const consumer = 'apps/shell-super-app/src/market-client-consumer.ts';
      yield* write(root, consumer, source);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(file);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

for (const [name, imported, allowed] of [
  ['actual worker selected operation', 'executeRecordOwnerExecutionOutcomeWithAuthorization', true],
  [PRIVATE_COLOCATED_CALLABLE_CASE, 'privatePrivacyClientCallable', false],
] as const) {
  it.live(`checks actual Privacy client ${name}`, () =>
    Effect.gen(function* actualPrivacyClientPublication() {
      const root = yield* makeActualPrivacyClientFixture();
      const clientFile = 'verticals/privacy/src/api/privacy-client.ts';
      const original = yield* Effect.promise(() => readFile(path.join(root, clientFile), 'utf-8'));
      yield* write(root, clientFile, `${original}\nexport const privatePrivacyClientCallable=()=>globalThis;\n`);
      const consumer = 'apps/shell-super-app/src/privacy-client-consumer.ts';
      yield* write(root, consumer, `import { ${imported} } from '@app/privacy/api/client';\n`);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(clientFile);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

it.live('binds actual published-package Read clients back to the enrolled owner aggregate', () =>
  Effect.gen(function* actualPublishedPackageClient() {
    const root = yield* makeFixture();
    const workspace = path.resolve(import.meta.dirname, '../..');
    const owner = 'verticals/price-group-catalog';
    const contractPackage = 'packages/price-group-catalog-contracts';
    const packageName = '@app/price-group-catalog';
    yield* write(root, WORKSPACE_MANIFEST_PATH, VERTICALS_WORKSPACE_DECLARATION);
    yield* write(
      root,
      BOUNDARY_FIXTURE_TOPOLOGY,
      JSON.stringify({
        shell: { id: BOUNDARY_FIXTURE_SHELL_ID, path: BOUNDARY_FIXTURE_SHELL_PATH },
        verticals: [
          { id: INVENTORY_DEPLOYMENT_ID, path: INVENTORY_VERTICAL_PATH },
          { id: 'price-group-catalog', path: owner },
        ],
      }),
    );
    for (const folder of [owner, contractPackage, SHARED_CONTRACTS_WORKSPACE_PATH]) {
      const sources = yield* readPricingSourceTree(workspace, folder);
      for (const [file, source] of sources) {
        yield* write(root, file, source);
      }
    }
    yield* write(
      root,
      SHELL_PACKAGE_JSON_PATH,
      JSON.stringify({
        dependencies: { [packageName]: WORKSPACE_DEPENDENCY_VERSION },
        name: SHELL_PACKAGE_SPECIFIER,
      }),
    );
    yield* Effect.promise(() => mkdir(path.join(root, APP_PACKAGE_LINK_DIRECTORY), { recursive: true }));
    for (const [name, folder] of [
      ['price-group-catalog', owner],
      ['price-group-catalog-contracts', contractPackage],
      [SHARED_CONTRACTS_WORKSPACE_NAME, SHARED_CONTRACTS_WORKSPACE_PATH],
    ] as const) {
      yield* Effect.promise(() =>
        symlink(path.join(root, folder), path.join(root, APP_PACKAGE_LINK_DIRECTORY, name), 'dir'),
      );
    }
    const aggregateFile = `${owner}/src/api/price-group-catalog-client.ts`;
    const aggregate = yield* Effect.promise(() => readFile(path.join(root, aggregateFile), 'utf-8'));
    yield* write(root, aggregateFile, `${aggregate}\nexport const unclaimedClientCallable = () => globalThis;`);
    const consumer = 'apps/shell-super-app/src/published-package-client-consumer.ts';
    for (const [binding, allowed] of [
      ['executePriceGroupDefinitionWithAuthorization, executePriceGroupSourceAssociationsWithAuthorization', true],
      ['unclaimedClientCallable', false],
    ] as const) {
      yield* write(root, consumer, `import { ${binding} } from '${packageName}/api/client';\n`);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(allowed);
    }
    yield* write(
      root,
      consumer,
      `import { executePriceGroupDefinitionWithAuthorization } from '${packageName}/api/client';\n`,
    );
    const packageFile = `${contractPackage}/package.json`;
    const metadata = yield* Effect.promise(() => readFile(path.join(root, packageFile), 'utf-8'));
    yield* write(root, packageFile, metadata.replace('pricing.price-group-catalog', 'foreign.owner'));
    expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
    yield* write(root, packageFile, metadata);
    const clientFile = `${contractPackage}/src/api/price-group-definition-client.ts`;
    const client = yield* Effect.promise(() => readFile(path.join(root, clientFile), 'utf-8'));
    const invalidClient = client.replace('operationGateway.invoke(', 'unownedGateway.invoke(');
    expect(invalidClient).not.toBe(client);
    yield* write(root, clientFile, invalidClient);
    expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
  }),
);

for (const [name, imported, allowed] of [
  [
    'actual finalization selected operations',
    'executeFinalizeOrderTaxWithAuthorization, executeFinalOrderTaxWithAuthorization',
    true,
  ],
  [PRIVATE_COLOCATED_CALLABLE_CASE, 'privateTaxClientCallable', false],
] as const) {
  it.live(`checks actual Tax client ${name}`, () =>
    Effect.gen(function* actualTaxClientPublication() {
      const root = yield* makeActualTaxClientFixture();
      const clientFile = 'verticals/tax/src/api/tax-client.ts';
      const original = yield* Effect.promise(() => readFile(path.join(root, clientFile), 'utf-8'));
      yield* write(root, clientFile, `${original}\nexport const privateTaxClientCallable=()=>globalThis;\n`);
      const consumer = 'apps/shell-super-app/src/tax-client-consumer.ts';
      yield* write(root, consumer, `import { ${imported} } from '@app/tax/api/client';\n`);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(clientFile);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

for (const [variant, addition, privateSelection, allowed] of [
  ['public selections', '', false, true],
  ['private callable', '\nexport const privateQuantityDispatch = () => globalThis;\n', true, false],
  [
    'eager namespace mutation',
    '\nconst schemaAlias = Schema; Object.assign(schemaAlias, { Struct: () => globalThis });\n',
    false,
    false,
  ],
] as const) {
  it.live(`checks actual Catalog quantity contract ${variant}`, () =>
    Effect.gen(function* actualQuantityContract() {
      const root = yield* makeActualCatalogSelectionFixture(CATALOG_QUANTITY_CONTRACT);
      const original = yield* Effect.promise(() => readFile(path.join(root, CATALOG_QUANTITY_CONTRACT), 'utf-8'));
      yield* write(root, CATALOG_QUANTITY_CONTRACT, original + addition);
      yield* write(
        root,
        'apps/shell-super-app/src/catalog-quantity-consumer.ts',
        privateSelection
          ? "import { privateQuantityDispatch } from '@app/catalog/domain/catalog-quantity-handoff';\n"
          : "import { CatalogQuantityBasisSchema, CatalogQuantityHandoffReadySchema, CatalogQuantityHandoffSchema } from '@app/catalog/domain/catalog-quantity-handoff';\nimport type { CatalogQuantityHandoff, CatalogQuantityHandoffReady } from '@app/catalog/domain/catalog-quantity-handoff';\n",
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : variant).toBe(allowed);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(CATALOG_QUANTITY_CONTRACT);
      }
    }),
  );
}

for (const [subpath, publicBinding] of [
  ['catalog-selection-purpose', 'selectSmallestCompleteCatalogSelectionBasis'],
  ['catalog-unit-conversion-evidence', 'catalogUnitConversionProves'],
] as const) {
  for (const privateSelection of [false, true]) {
    it.live(`checks actual published Catalog routine ${publicBinding} private=${privateSelection}`, () =>
      Effect.gen(function* actualPublishedCatalogRoutine() {
        const file = `verticals/catalog/shared/domain/${subpath}.ts`;
        const root = yield* makeActualCatalogSelectionFixture(file);
        const privateOrigin = 'verticals/catalog/src/handlers/private-contract.ts';
        yield* write(root, privateOrigin, 'export const privateRoutine = () => true;\n');
        const original = yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
        yield* write(
          root,
          file,
          privateSelection
            ? `${original}\nexport { privateRoutine } from '../../src/handlers/private-contract.ts';\n`
            : original,
        );
        const binding = privateSelection ? 'privateRoutine' : publicBinding;
        yield* write(
          root,
          'apps/shell-super-app/src/catalog-routine-consumer.ts',
          `import { ${binding} } from '@app/catalog/domain/${subpath}';\n`,
        );
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(
          !privateSelection,
        );
        if (privateSelection && Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain(privateOrigin);
        }
      }),
    );
  }
}

for (const [name, extraImport, tail] of [
  [
    'private child',
    "import { privateAggregateApi } from '../src/handlers/private-contract.ts';\n",
    '.addHttpApi(privateAggregateApi)',
  ],
  ['unknown method', '', '.unknownContractOperation()'],
  ['unknown child', '', '.addHttpApi(missingAggregateApi)'],
] as const) {
  it.live(`rejects a ${name} after the actual Customer Context long public API chain`, () =>
    Effect.gen(function* rejectLongApiChainTail() {
      const root = yield* makeActualCustomerContextAggregateFixture();
      const apiFile = 'verticals/commerce-customer-context/shared/api.ts';
      const privateOrigin = CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH;
      yield* write(
        root,
        privateOrigin,
        "import { HttpApi } from 'effect/http-api'; export const privateAggregateApi = HttpApi.make('PrivateApi');\n",
      );
      const source = yield* Effect.promise(() => readFile(path.join(root, apiFile), 'utf-8'));
      expect(source.match(/\.addHttpApi\(/gu)?.length).toBeGreaterThan(64);
      const changed = source.replace('.pipe(identity);', `${tail}.pipe(identity);`);
      expect(changed).not.toBe(source);
      yield* write(root, apiFile, extraImport + changed);
      const consumer = 'apps/shell-super-app/src/customer-context-aggregate-consumer.ts';
      yield* write(
        root,
        consumer,
        "import { commerceCustomerContextApi } from '@app/commerce-customer-context/api';\n",
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(consumer);
      }
    }),
  );
}

for (const [origin, addition] of [
  [
    'global network authority',
    "export const privateRuntimeDispatch = () => globalThis.fetch('/private-owner-operation');",
  ],
  [
    'process execution authority',
    "import { execFileSync } from 'node:child_process';\nexport const privateRuntimeDispatch = () => execFileSync('private-owner-operation');",
  ],
] as const) {
  it.live(`rejects published neutral routine ${origin}`, () =>
    Effect.gen(function* privateRoutineAuthority() {
      const file = 'verticals/catalog/shared/domain/catalog-selection-purpose.ts';
      const root = yield* makeActualCatalogSelectionFixture(file);
      const original = yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
      yield* write(root, file, `${original}\n${addition}\n`);
      yield* write(
        root,
        'apps/shell-super-app/src/catalog-runtime-consumer.ts',
        "import { privateRuntimeDispatch } from '@app/catalog/domain/catalog-selection-purpose';\n",
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(result), origin).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(file);
        expect(Cause.pretty(result.cause)).toContain(FOREIGN_PRIVATE_DIAGNOSTIC);
      }
    }),
  );
}
