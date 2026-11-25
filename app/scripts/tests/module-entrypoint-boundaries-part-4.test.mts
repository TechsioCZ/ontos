import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Array as EffectArray, Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { validateGatewayIssuerEntrypoints } from '../check-module-entrypoint-boundaries.mts';
import { gatewayContextAuthorizationEntrypoints } from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasValidGovernedHttpCompositionRoot,
  hasOwnerLocalReadServiceFactory,
  hasNativeHttpActionMount,
  hasPublishedGeneratedContractShim,
} from '../generated-governed-http-boundary.mts';
import {
  hasGeneratedGovernedClientContract,
  hasGeneratedModuleApiReadContract,
  generatedModuleApiEntrypointReference,
} from '../generated-module-api-boundary.mts';
import { assertPublishedOutboxContractSource } from '../published-outbox-contracts.mts';
import {
  PRIVATE_COLOCATED_CALLABLE_CASE,
  PARTY_RESOURCE_SOURCE_PATH,
  CUSTOMER_CONTEXT_VERTICAL_PATH,
  CUSTOMER_CONTEXT_DEPLOYMENT_ID,
  CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_DEPENDENCY_VERSION,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  APP_PACKAGE_LINK_DIRECTORY,
  VERTICALS_WORKSPACE_DECLARATION,
  CATALOG_SELECTION_CONTRACT_SUBPATH,
  PRICING_SHARED_API_PATH,
  PRICING_HANDLER_PATH,
  BOUNDARY_FIXTURE_INVENTORY,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_MODULE_ID,
  CONNECTED_ENTRYPOINT_PROPERTY,
  CORE_RUNTIME_SOURCE_IMPORT,
  FAKE_CORE_SOURCE_IMPORT,
  EXPECTED_EFFECT_FAILURE,
  GOVERNED_SEARCH_HEADER,
  checkModuleEntrypointBoundaries,
  PROTECTED_AUTHORIZATION_SOURCE,
  STOCK_LIST_STEM,
  STOCK_LIST_READ_BINDING,
  ACTION_HEADER_FOR_TEST,
  GATEWAY_BYPASS_MARKER,
  INVENTORY_CONTRACT_IMPORT,
  AUTHORIZATION_VALUE,
  AUTHORIZATION_VALUE_TAIL,
  INVENTORY_API_PREFIX,
  DEFAULT_API_PREFIX,
  DEFAULT_API_PREFIX_TAIL,
  MODULE_API_HEADER,
  ACTION_FILE,
  WORKER_FILE,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_CLIENT_SOURCE_PATH,
  PARTY_DEPLOYMENT_ID,
  PARTY_MODULE_ID,
  PARTY_OUTBOX_SPECIFIER,
  PARTY_PACKAGE_NAME,
  INVENTORY_VERTICAL_PATH,
  validAction,
  write,
  governedClientFixture,
  moduleReadFixture,
  assertRejectedSources,
  makeFixture,
  ENGAGEMENT_ACTIONS,
  writeEngagementLifecycleFixture,
  EngagementInventorySchema,
  writeGovernedModuleApi,
  partyPackage,
  partyClientSource,
  generatedPartyDetailClientSource,
  generatedPartyActionHttpClientSource,
  assertPublishedPartyUsage,
  partyOutboxSource,
  readPricingSourceTree,
  RESOLVED_OWNER_CONSUMER,
  RENAMED_CONTRACTS_PACKAGE,
  makeResolvedOwnerFixture,
  CATALOG_SELECTION_CONTRACT,
  makeActualCatalogSelectionFixture,
  makeActualQuantityClientFixture,
  makeActualTaxClientFixture,
  makeActualCustomerContextAggregateFixture,
} from './module-entrypoint-boundary-fixtures.mts';

it.effect('governed client return contracts erase only types and retain every executable boundary check', () =>
  Effect.sync(() => {
    const expectation: Parameters<typeof hasGeneratedGovernedClientContract>[1] = {
      authorizedOperation: 'loadInventoryItemsClientWithAuthorization',
      defaultApiPrefix: INVENTORY_API_PREFIX,
      endpointGroup: 'inventoryItemsSearch',
      generatedHeader: GOVERNED_SEARCH_HEADER,
      invocationKind: 'provider',
      ownerApiValue: 'InventoryItemsSearchApi',
      ownerContractImport: INVENTORY_CONTRACT_IMPORT,
      publicOperation: 'loadInventoryItemsClient',
    };
    const requestType = 'InventoryItemsProviderRequest';
    const responseType = 'InventoryItemsProviderResponse';
    const schemaTypeImport = "import type { Schema } from 'effect';";
    const original = governedClientFixture({
      ...expectation,
      apiValue: expectation.ownerApiValue,
      clientHelper: 'inventoryItemsClient',
      contractImport: expectation.ownerContractImport,
    });
    const aliases = `type EndpointResult = ReturnType<HttpApiClient.ForApi<typeof ${expectation.ownerApiValue}>['${expectation.endpointGroup}']['execute']>;
 type AuthorizedResult = Effect.Effect<${responseType}, Effect.Error<EndpointResult> | Schema.SchemaError>;`;
    const typed = original
      .replace(
        "import { Effect, Redacted } from 'effect';",
        `import { Effect, Redacted } from 'effect';\n${schemaTypeImport}\nimport type { HttpApiClient } from 'effect/http-api';`,
      )
      .replace(`import type { ${requestType} }`, `import type { ${requestType}, ${responseType} }`)
      .replace(
        'type InventoryItemsSearchAuthorizedInvocation',
        `${aliases}\ntype InventoryItemsSearchAuthorizedInvocation`,
      )
      .replace(') =>\n  inventoryItemsClient', '): AuthorizedResult =>\n  inventoryItemsClient')
      .replace(
        ') =>\n  operationGateway.invoke',
        `): ReturnType<typeof operationGateway.invoke<${responseType}, Effect.Error<AuthorizedResult>>> =>\n  operationGateway.invoke`,
      );
    expect(hasGeneratedGovernedClientContract(typed, expectation)).toBe(true);
    expect(hasGeneratedGovernedClientContract(`// Česky\n${typed}`, expectation)).toBe(true);
    for (const invalid of [
      typed.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
      typed.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL),
      typed.replace('operationGateway.invoke(', `${GATEWAY_BYPASS_MARKER}(`),
      typed.replace(schemaTypeImport, "import { Schema } from 'effect';"),
      typed.replace(`import type { ${requestType}, ${responseType} }`, `import type { ${responseType} }`),
      typed.replace("from 'effect/http-api'", "from '../private-client.ts'"),
      typed.replace(': AuthorizedResult =>', ': AuthorizedResult< =>'),
      typed.replace(
        'type EndpointResult =',
        'const injected = operationGateway.invoke(() => Effect.void); type EndpointResult =',
      ),
    ]) {
      expect(hasGeneratedGovernedClientContract(invalid, expectation)).toBe(false);
    }
  }),
);

it.live('admits exact Federation package metadata while preserving executable and computed runtime boundaries', () =>
  Effect.gen(function* federationMetadataBoundary() {
    const root = yield* makeFixture();
    const config = 'verticals/inventory-stock/backend-federation.config.ts';
    const metadataSource = `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const federationRuntimeVersion = (require('@module-federation/runtime/package.json') as { version: string }).version;
export default { shared: { '@module-federation/runtime': { requiredVersion: federationRuntimeVersion, singleton: true } } };`;
    yield* write(root, config, metadataSource);
    yield* checkModuleEntrypointBoundaries(root);
    yield* assertRejectedSources(
      root,
      config,
      [
        "const runtime = require('@module-federation/runtime');",
        "const runtime = import('@module-federation/runtime/package.json/runtime');",
        "const runtime = import('@module-federation/runtime/package.json' + '/runtime');",
        "const runtime = require('@module-federation/runtime/package.json' + '/runtime');",
        "import * as runtime from '@module-federation/runtime';",
        "import { loadRemote as resolveRemote } from '@module-federation/runtime'; resolveRemote('inventory/Widget');",
        "const metadata = require('@module-federation/runtime/package.json'); loadRemote('inventory/Widget');",
        "const metadata = require('@module-federation/runtime/package.json'); runtime.preloadRemote([]);",
        "const metadata = require('@module-federation/runtime/package.json'); runtime.registerRemotes([]);",
        "const runtime = require('@module-federation/runtime-core/package.json');",
      ],
      /native Federation runtime imports.*approved Shell module-entrypoint loader/u,
    );
  }),
);

it.live(
  'validates all four live shared Action registrations and inventories each concrete identity',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture(true);
    yield* writeEngagementLifecycleFixture(root);
    yield* checkModuleEntrypointBoundaries(root);
    const inventory = Schema.decodeUnknownSync(EngagementInventorySchema)(
      yield* Effect.promise(() => readFile(path.join(root, BOUNDARY_FIXTURE_INVENTORY), 'utf-8')),
    );
    expect(inventory.entries.filter((entry) => entry.owner === PARTY_MODULE_ID)).toEqual(
      ENGAGEMENT_ACTIONS.map((action) => ({
        authorization: { kind: 'protected' },
        deployment: PARTY_DEPLOYMENT_ID,
        entrypointKey: `${PARTY_MODULE_ID}.${action}`,
        owner: PARTY_MODULE_ID,
        surface: 'action',
      })),
    );
  }),
);

for (const suffix of ['search', 'report']) {
  it.live(
    `accepts module API names ending in ${suffix} without reclassifying them`,
    Effect.fn(function* governanceScenario24() {
      const root = yield* makeFixture();
      yield* writeGovernedModuleApi(root);
      const files = [
        'shared/api.ts',
        'api/index.ts',
        'shared/apis/stock-list.ts',
        'src/api/stock-list.read.ts',
        'src/api/stock-list-client.ts',
        'api/stock-list-read-server.ts',
        'vertical.manifest.ts',
        'vertical.registration.ts',
      ];
      yield* Effect.all(
        files.map(
          Effect.fn(function* governanceScenario25(file) {
            const original = `${INVENTORY_VERTICAL_PATH}/${file}`;
            const source = yield* Effect.promise(() => readFile(path.join(root, original), 'utf-8'));
            const renamed = original.replaceAll(STOCK_LIST_STEM, `stock-${suffix}`);
            yield* write(
              root,
              renamed,
              source
                .replaceAll(STOCK_LIST_STEM, `stock-${suffix}`)
                .replaceAll('StockList', suffix === 'search' ? 'StockSearch' : 'StockReport')
                .replaceAll('stockList', suffix === 'search' ? 'stockSearch' : 'stockReport'),
            );
            if (renamed !== original) {
              yield* Effect.promise(() => rm(path.join(root, original)));
            }
          }),
        ),
        { concurrency: 'unbounded' },
      );
      yield* checkModuleEntrypointBoundaries(root);
    }),
  );
}

it.live('rejects missing headers, spoofed metadata, and stale generated descriptors', () =>
  Effect.gen(function* testEffect7() {
    const root = yield* makeFixture();
    yield* write(
      root,
      ACTION_FILE,
      `${ACTION_HEADER_FOR_TEST}
// @ontos-action-owner inventory.stock
// @ontos-action-slug reserve
export const stale = true;
`,
    );
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(/scaffold:action/u);
    yield* write(root, ACTION_FILE, `export const ignored = true;`);
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(/scaffold:action/u);
    yield* write(
      root,
      ACTION_FILE,
      `${ACTION_HEADER_FOR_TEST}
// @ontos-action-owner inventory.stock
// @ontos-action-slug reserve
// defineTenantModuleEntrypoint({ access: 'write', entrypointKey: 'inventory.stock.reserve', moduleKey: 'inventory.stock', role: 'action' });
export const spoofed = true;
`,
    );
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(/scaffold:action/u);
    yield* write(root, ACTION_FILE, validAction);
    yield* write(
      root,
      WORKER_FILE,
      `// @generated by OntOS Codesmith Outbox Worker v1
// @ontos-outbox-worker-key inventory.stock.project
// @ontos-outbox-worker-owner inventory.stock
export const stale = true;
`,
    );
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(/scaffold:outbox-worker/u);
    yield* write(root, WORKER_FILE, `export const ignored = true;`);
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(/scaffold:outbox-worker/u);
  }),
);

it('rejects a ResourceRef import whose public path is not resources/<slug>', () => {
  expect(() =>
    assertPublishedPartyUsage({
      dependencyPackageJson: {
        ...partyPackage,
        exports: { './resource/party': PARTY_RESOURCE_SOURCE_PATH },
      },
      moduleSpecifiers: ['@app/party-registry/resource/party'],
    }),
  ).toThrow(/not a published schema-only contract subpath/u);
});

it('rejects barrels and arbitrary exported owner subpaths', () => {
  for (const specifier of [
    PARTY_PACKAGE_NAME,
    '@app/party-registry/shared/domain/party',
    '@app/party-registry/api',
    '@app/party-registry/actions/create-party',
  ]) {
    expect(() => assertPublishedPartyUsage({ moduleSpecifiers: [specifier] })).toThrow(
      /not a published schema-only contract subpath/u,
    );
  }
});

it('rejects a client aggregate that imports provider backend or private source', () => {
  for (const forbiddenImport of [
    '../../api/index.ts',
    '../db/repository.ts',
    '../services/party.service.ts',
    '../actions/create-party.action.ts',
  ]) {
    expect(() =>
      assertPublishedPartyUsage({
        moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
        readExportSource: (target) => {
          if (target === PARTY_CLIENT_SOURCE_PATH) {
            return `${partyClientSource}import value from '${forbiddenImport}';\nvoid value;\n`;
          }
          return generatedPartyDetailClientSource;
        },
      }),
    ).toThrow(/must remain a generated public Effect client aggregate/u);
  }
});

it('rejects Action HTTP client leaves with mismatched owner or filename slug', () => {
  for (const invalidSource of [
    generatedPartyActionHttpClientSource.replace(
      '@ontos-action-http-owner party.registry',
      '@ontos-action-http-owner commerce.customer-context',
    ),
    generatedPartyActionHttpClientSource.replace(
      '@ontos-action-http-slug archive-party',
      '@ontos-action-http-slug merge-party',
    ),
  ]) {
    expect(() =>
      assertPublishedPartyUsage({
        moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
        readExportSource: (target) =>
          target === PARTY_CLIENT_SOURCE_PATH
            ? `${partyClientSource}export * from './archive-party-action-client.ts';\n`
            : invalidSource,
      }),
    ).toThrow(/must remain a generated public Effect client aggregate/u);
  }
});

it('rejects an Outbox producer that substitutes deployment appId for moduleId', () => {
  expect(() =>
    assertPublishedOutboxContractSource({
      moduleId: PARTY_MODULE_ID,
      source: partyOutboxSource.replace(
        '@ontos-outbox-producer party.registry',
        '@ontos-outbox-producer party-registry',
      ),
      specifier: PARTY_OUTBOX_SPECIFIER,
    }),
  ).toThrow(/must remain a generated schema-only Outbox contract/u);
});

for (const [binding, disconnected] of [
  ['authenticatePrincipal: authenticateOperationPrincipal', 'authenticatePrincipal: disconnectedPrincipal'],
  [STOCK_LIST_READ_BINDING, 'registration: unrelatedRead'],
] as const) {
  it.live(
    `shared governed HTTP handler requires connected ${binding}`,
    Effect.fn(function* mergedScenario1() {
      const root = yield* makeFixture();
      const serverFile = 'verticals/inventory-stock/api/stock-list-read-server.ts';
      yield* writeGovernedModuleApi(root);
      const server = yield* Effect.promise(() => readFile(path.join(root, serverFile), 'utf-8'));
      yield* checkModuleEntrypointBoundaries(root);
      yield* write(root, serverFile, server.replace(binding, disconnected));
      yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
        onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/module APIs require/u),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
      yield* write(root, serverFile, server);
      yield* checkModuleEntrypointBoundaries(root);
      yield* write(
        root,
        serverFile,
        server.replace("from '@app/core-runtime/http/governed-read'", "from './unused-neighbor.ts'"),
      );
      yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
        onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/module APIs require/u),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
    }),
  );
}

it.effect('accepts exactly the three issuer classifications regardless of declaration order', () =>
  validateGatewayIssuerEntrypoints(EffectArray.reverse(gatewayContextAuthorizationEntrypoints)),
);

it('follows the actual immutable Core entrypoint reference while preserving owner and authorization identity', () => {
  const base = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
  const expectation = { kind: 'protected' } as const;
  const accepts = (source: string) => {
    const connected = generatedModuleApiEntrypointReference(source, 'stockListRead');
    return (
      connected !== undefined &&
      hasGeneratedModuleApiReadContract(source, INVENTORY_MODULE_ID, STOCK_LIST_STEM, expectation, connected.name)
    );
  };
  expect(hasGeneratedModuleApiReadContract(base, INVENTORY_MODULE_ID, STOCK_LIST_STEM, expectation)).toBe(true);
  const renamed = base.replaceAll('stockListEntrypoint', 'selectedReadContext');
  expect(accepts(renamed)).toBe(true);
  const shorthand = base
    .replaceAll('stockListEntrypoint', 'entrypoint')
    .replace('entrypoint: entrypoint', 'entrypoint');
  expect(accepts(shorthand)).toBe(true);
  expect(accepts(renamed.replace(CONNECTED_ENTRYPOINT_PROPERTY, "'entrypoint': selectedReadContext"))).toBe(true);
  for (const invalid of [
    renamed.replace('export const selectedReadContext', 'export let selectedReadContext'),
    `${renamed.replace(CONNECTED_ENTRYPOINT_PROPERTY, 'entrypoint: wrongContext')}\nconst wrongContext = fakeFactory();`,
    renamed.replace("moduleKey: 'inventory.stock'", "moduleKey: 'other.owner'"),
    renamed.replace(PROTECTED_AUTHORIZATION_SOURCE, "{ kind: 'protected', permission: 'module.access' }"),
    renamed.replace("role: 'api'", "role: 'worker'"),
    renamed.replace('= defineTenantModuleEntrypoint(', '= defineSystemModuleEntrypoint('),
    renamed.replace(CORE_RUNTIME_SOURCE_IMPORT, FAKE_CORE_SOURCE_IMPORT),
    `${renamed}\nconst escaped = selectedReadContext;`,
    `${renamed}\nqueueMicrotask(() => Object.assign(selectedReadContext, { authorization: { kind: 'public' } }));`,
    renamed.replace(CONNECTED_ENTRYPOINT_PROPERTY, "entrypoint: selectedReadContext, ['entrypoint']: wrongContext"),
    shorthand.replace('accessKind:', '...untrusted, accessKind:'),
  ]) {
    expect(accepts(invalid)).toBe(false);
  }
});

it('proves inferred native scoped factories and nested callback type parameters without accepting forged ownership', () => {
  const owner = INVENTORY_VERTICAL_PATH;
  const file = `${owner}/src/api/stock-list.read.ts`;
  const service = `${owner}/src/services/stock-list.ts`;
  const sources = new Map([
    [file, "import { factory } from '../services/stock-list.ts';"],
    [
      service,
      `import type { ScopedTransactionExecutor, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
export const factory = (transaction: ScopedTransactionExecutor, scope: OperationalScope) => Effect.succeed({ read: () => Effect.succeed(scope.tenantId) });`,
    ],
  ]);
  expect(hasOwnerLocalReadServiceFactory(sources, file, owner, 'factory')).toBe(true);
  const valid = sources.get(service) ?? '';
  sources.set(service, valid.replace('(transaction:', "Effect.fn('factory')((transaction:").replace(' });', ' }));'));
  expect(hasOwnerLocalReadServiceFactory(sources, file, owner, 'factory')).toBe(true);
  for (const invalid of [
    valid.replace(CORE_RUNTIME_SOURCE_IMPORT, FAKE_CORE_SOURCE_IMPORT),
    valid.replace('transaction: ScopedTransactionExecutor', 'transaction: unknown'),
    valid.replace('scope: OperationalScope', 'scope: unknown'),
  ]) {
    sources.set(service, invalid);
    expect(hasOwnerLocalReadServiceFactory(sources, file, owner, 'factory')).toBe(false);
  }
  sources.set(service, valid);
  sources.set(file, "import { factory } from '../../../other/src/services/stock-list.ts';");
  expect(hasOwnerLocalReadServiceFactory(sources, file, owner, 'factory')).toBe(false);
});

it('admits only the scoped native HTTP RequestInit mount and retains the Action runtime boundary', () => {
  const source = `import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
const layers = GovernedReadLayer.mergeAll(
// <generated-governed-http-handler-layers>
exampleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive), GovernedReadLayer.provide(GovernedFetchHttpClient.layer.pipe(GovernedReadLayer.provide(GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }))))),
// </generated-governed-http-handler-layers>
);`;
  expect(hasNativeHttpActionMount(source, 'exampleActionApiLive')).toBe(true);
  for (const invalid of [
    source.replace('governedActionRuntimeLive', 'otherRuntime'),
    source.replace("from 'effect/http'", "from './fake-http.ts'"),
    source.replace("redirect: 'manual'", "redirect: 'follow'"),
    source.replace("cache: 'no-store'", "cache: 'no-store', headers: secretHeaders"),
    source.replace('GovernedFetchHttpClient.layer.pipe(', 'otherLayer.pipe('),
    source.replace('exampleActionApiLive.pipe(', 'exampleActionApiLive.pipe(unsafeOperator, '),
  ]) {
    expect(hasNativeHttpActionMount(invalid, 'exampleActionApiLive')).toBe(false);
  }
});

it.live('accepts actual CCC named recovery reexports and rejects provenance or executable escapes', () =>
  Effect.gen(function* actualNamedCustomerContextRecovery() {
    const root = path.resolve(import.meta.dirname, '../..');
    const owner = CUSTOMER_CONTEXT_VERTICAL_PATH;
    const deployment = path.posix.basename(owner);
    const [trees, metadata] = yield* Effect.all([
      Effect.all(
        [
          `${owner}/api`,
          `${owner}/shared`,
          `${owner}/src`,
          'packages/customer-market-retirement-contracts',
          'packages/customer-payment-term-contracts',
          // customer-price-group-resolution calls the Catalog's operation reference from this package.
          'packages/price-group-catalog-contracts',
          // Both payment-terms resolutions call the Payment Term Catalog's operation reference from this package.
          'packages/payment-term-catalog-contracts',
        ].map((folder) => readPricingSourceTree(root, folder)),
      ),
      Effect.all(
        [
          `${owner}/package.json`,
          `${owner}/vertical.manifest.ts`,
          `${owner}/vertical.registration.ts`,
          // market-bootstrap-resolution calls the Market Catalog's published module-api contracts.
          'verticals/commerce-market-catalog/package.json',
        ].map((file) =>
          Effect.promise(() => readFile(path.join(root, file), 'utf-8')).pipe(
            Effect.map((source) => [file, source] as const),
          ),
        ),
      ),
    ]);
    const sources = new Map([...trees.flat(), ...metadata]);
    const shared = `${owner}/shared/api.ts`;
    const contractFile = `${owner}/shared/apis/market-retirement-reservation-recovery.ts`;
    const clientFile = `${owner}/src/api/market-retirement-reservation-recovery-client.ts`;
    const contractSpecifier = '@app/customer-market-retirement-contracts/market-retirement-reservation-recovery';
    const contract = sources.get(contractFile) ?? '';
    const client = sources.get(clientFile) ?? '';
    for (const shim of [contract, client]) {
      expect(shim).toContain('export {');
      expect(shim).toContain('export type {');
    }
    expect(hasPublishedGeneratedContractShim(sources, contractFile, contract)).toBe(true);
    const inlineType = `${MODULE_API_HEADER}// @ontos-public-contract ${contractSpecifier}\nexport { MarketRetirementReservationRecoveryApi, type MarketRetirementReservationRecoveryRequest } from '${contractSpecifier}';\n`;
    expect(hasPublishedGeneratedContractShim(sources, contractFile, inlineType)).toBe(true);
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, deployment, diagnostics), diagnostics.join('\n')).toBe(
      true,
    );

    const icoReadFile = `${owner}/src/api/organization-customer-profile-ico.read.ts`;
    const icoRead = sources.get(icoReadFile) ?? '';
    expect(
      hasGeneratedModuleApiReadContract(icoRead, 'commerce.customer-context', 'organization-customer-profile-ico'),
    ).toBe(true);
    for (const invalid of [
      icoRead.replace(
        "const readKey = 'commerce.customer-context.api.organization-customer-profile-ico'",
        "const readKey = 'commerce.customer-context.api.foreign-read'",
      ),
      icoRead.replace("const ownerModuleKey = 'commerce.customer-context'", "const ownerModuleKey = 'foreign.owner'"),
      icoRead.replace('const readKey =', 'let readKey ='),
      icoRead.replace('    readKey,', "    readKey, readKey: 'commerce.customer-context.api.foreign-read',"),
    ]) {
      expect(invalid).not.toBe(icoRead);
      expect(
        hasGeneratedModuleApiReadContract(invalid, 'commerce.customer-context', 'organization-customer-profile-ico'),
      ).toBe(false);
      expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [icoReadFile, invalid]]), shared, deployment)).toBe(
        false,
      );
    }
    const manifestFile = `${owner}/vertical.manifest.ts`;
    const manifest = sources.get(manifestFile) ?? '';
    const actionEntry = "'reserve-market-retirement-action': ReserveMarketRetirementActionApi,";
    const invalidActionMetadata = [
      manifest.replace(actionEntry, ''),
      manifest.replace(actionEntry, `${actionEntry}\n${actionEntry}`),
      manifest.replace(actionEntry, "'reserve-market-retirement-action': UnownedActionApi,"),
      manifest.replace(
        "operationKey: 'reserveMarketRetirementAction.execute'",
        "operationKey: 'foreignAction.execute'",
      ),
      manifest.replace(
        'registration: reserveMarketRetirementAction,',
        'registration: reservePaymentTermRetirementAction,',
      ),
      manifest.replace(
        "from './shared/apis/reserve-market-retirement-action.ts'",
        "from './shared/apis/foreign-action.ts'",
      ),
      manifest.replace("apiKey: 'reserve-market-retirement-action'", "apiKey: 'unpublished-action'"),
    ];
    for (const invalid of invalidActionMetadata) {
      expect(invalid).not.toBe(manifest);
      expect(
        hasCompleteGeneratedModuleApiSeam(
          new Map([...sources, [manifestFile, invalid]]),
          shared,
          CUSTOMER_CONTEXT_DEPLOYMENT_ID,
        ),
      ).toBe(false);
    }
    const registrationFile = `${owner}/vertical.registration.ts`;
    const registration = sources.get(registrationFile) ?? '';
    const withActionBrowserClient = registration.replace(
      '// <generated-module-registration-apis>',
      "// <generated-module-registration-apis>\n'reserve-market-retirement-action': () => import('./src/api/reserve-market-retirement-action-client.ts'),",
    );
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [registrationFile, withActionBrowserClient]]),
        shared,
        CUSTOMER_CONTEXT_DEPLOYMENT_ID,
      ),
    ).toBe(false);
    const marker = `${MODULE_API_HEADER}// @ontos-public-contract ${contractSpecifier}\n`;
    for (const invalid of [
      contract.replaceAll(`from '${contractSpecifier}'`, "from '@app/wrong-contracts/recovery'"),
      contract.replaceAll(`from '${contractSpecifier}'`, "from '../../src/private.ts'"),
      `${contract}\nexport type { Other } from '@app/wrong-contracts/recovery';`,
      `${contract}\nexport const injected = true;`,
      `${contract}\nexport { injected };`,
      `${contract}\nexecutePrivateOperation();`,
      `import { injected } from './private.ts';\n${contract}`,
      `${marker}export * as namespace from '${contractSpecifier}';`,
      `${marker}export {} from '${contractSpecifier}';`,
      `${marker}export { Injected as Original } from '${contractSpecifier}';`,
      `${marker}export { Injected } from \`${contractSpecifier}\`;`,
      contract.replace(`// @ontos-public-contract ${contractSpecifier}\n`, ''),
    ]) {
      expect(invalid).not.toBe(contract);
      expect(hasPublishedGeneratedContractShim(sources, contractFile, invalid)).toBe(false);
    }
    // Full owner integration for both source paths; the shared classifier above covers each grammar escape.
    for (const [file, invalid] of [
      [contractFile, `${contract}\nexecutePrivateOperation();`],
      [clientFile, client.replaceAll(`from '${contractSpecifier}/client'`, "from '@app/wrong-contracts/recovery'")],
    ]) {
      expect(invalid).not.toBe(sources.get(file));
      const changed = new Map([...sources, [file, invalid]]);
      expect(hasCompleteGeneratedModuleApiSeam(changed, shared, deployment)).toBe(false);
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
  // Scoped owner factories execute after receiving; their Crypto requirement must stay visible in the runtime context.
  Layer.provideMerge(nodeCryptoLayer),
  Layer.provide(ModuleCallRouteLive.pipe(Layer.provide(Layer.mergeAll(nodeCryptoLayer, compositionHttpClientLive)))),
);`;
    expect(handler).toContain(ownerRuntime);
    const direct = handler
      .replace('  makeReadRuntimeLive,', '  ReadRuntimeLive,')
      .replace(
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
    for (const invalid of [direct, aliased]) {
      expect(invalid).not.toBe(handler);
      expect(hasValidGovernedHttpCompositionRoot(shared, invalid)).toBe(false);
    }
  }),
);

it.live(
  'preserves owner-local implementations and genuine public ResourceRef reexports through real package exports',
  () =>
    Effect.gen(function* acceptsResolvedPublicOrigin() {
      const root = yield* makeResolvedOwnerFixture();
      yield* write(
        root,
        'verticals/inventory-stock/src/handlers/private.ts',
        'export const executePrivate = () => true;\n',
      );
      yield* write(
        root,
        RESOLVED_OWNER_CONSUMER,
        `import { executePrivate } from './handlers/private.ts';\nexport { PartyRefSchema } from '${RENAMED_CONTRACTS_PACKAGE}/resources/party';\nexport type { PartyRef } from '${RENAMED_CONTRACTS_PACKAGE}/resources/party';\n`,
      );
      yield* checkModuleEntrypointBoundaries(root);
    }),
);

it.live('proves readonly native Schema field projections and omissions without getters or escaped descriptors', () =>
  Effect.gen(function* nativeSchemaFieldProjections() {
    const root = yield* makeFixture();
    const workspace = path.resolve(import.meta.dirname, '../..');
    const actual = yield* Effect.promise(() =>
      readFile(path.join(workspace, 'verticals/privacy/shared/apis/organization-business-applicability.ts'), 'utf-8'),
    );
    const projection = actual.slice(
      actual.indexOf('interface ProjectionFields'),
      actual.indexOf('\nconst sourceIntent'),
    );
    expect(projection).toContain('const intentFields =');
    const sourceFile = `${INVENTORY_VERTICAL_PATH}/shared/domain/projection-fields.ts`;
    const markerFile = `${INVENTORY_VERTICAL_PATH}/shared/domain/projection-markers.ts`;
    const markers = `import { Schema } from 'effect';
export const MarkerSchema = Schema.Union([Schema.Struct({
  allowedFields: Schema.Array(Schema.String), consumerModuleId: Schema.Literal('inventory.stock'),
  operation: Schema.Literal('READ'), projectionVersion: Schema.Literal('v1'),
})]);
export const dormantMapper = (value: string) => { const local = { reason: '' }; local.reason = value; return local; };`;
    const digestField = 'inputDigest: Digest,';
    const source = `import { Schema, Struct } from 'effect';
import { MarkerSchema } from './projection-markers.ts';
const Digest = Schema.String;
const [marker] = MarkerSchema.members;
${projection}
export const ProjectedSchema = Schema.Struct({ ...intentFields(marker) });
export const OmittedSchema = Schema.Struct(Struct.omit(ProjectedSchema.fields, ['operation']));`;
    yield* write(root, WORKSPACE_MANIFEST_PATH, VERTICALS_WORKSPACE_DECLARATION);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/package.json`,
      JSON.stringify({
        exports: { './projection-fields': './shared/domain/projection-fields.ts' },
        modernjs: { appId: INVENTORY_DEPLOYMENT_ID, ontosModule: { moduleId: INVENTORY_MODULE_ID } },
        name: INVENTORY_PACKAGE_SPECIFIER,
      }),
    );
    yield* write(
      root,
      SHELL_PACKAGE_JSON_PATH,
      JSON.stringify({
        dependencies: { [INVENTORY_PACKAGE_SPECIFIER]: WORKSPACE_DEPENDENCY_VERSION },
        name: SHELL_PACKAGE_SPECIFIER,
      }),
    );
    yield* Effect.promise(() => mkdir(path.join(root, APP_PACKAGE_LINK_DIRECTORY), { recursive: true }));
    yield* Effect.promise(() =>
      symlink(
        path.join(root, INVENTORY_VERTICAL_PATH),
        path.join(root, APP_PACKAGE_LINK_DIRECTORY, INVENTORY_DEPLOYMENT_ID),
        'dir',
      ),
    );
    yield* write(
      root,
      'apps/shell-super-app/src/schema-fields-consumer.ts',
      `import { ProjectedSchema, OmittedSchema } from '${INVENTORY_PACKAGE_SPECIFIER}/projection-fields';`,
    );
    const aliasSource = source
      .replace('import { MarkerSchema }', 'import { MarkerSchema, DirectSchema as Alias }')
      .replace('Struct.omit(ProjectedSchema.fields', 'Struct.omit(Alias.fields');
    const aliasMarkers = `${markers}\nexport const DirectSchema = Schema.Struct({ operation: Schema.String });`;
    for (const [name, current, descriptor, allowed] of [
      ['native fields', source, markers, true],
      [
        'native nominal brand allocation',
        `import { Brand } from 'effect';\n${source}\nconst nominal = Brand.nominal<string>();`,
        markers,
        true,
      ],
      [
        'foreign nominal brand',
        `import { Brand } from './foreign-effect.ts';\n${source}\nconst nominal = Brand.nominal<string>();`,
        markers,
        false,
      ],
      [
        'nominal brand with eager argument',
        `import { Brand } from 'effect';\n${source}\nconst nominal = Brand.nominal<string>(acquireAuthority());`,
        markers,
        false,
      ],
      [
        'nominal brand executed eagerly',
        `import { Brand } from 'effect';\n${source}\nconst nominal = Brand.nominal<string>()(acquireAuthority());`,
        markers,
        false,
      ],

      ['native imported schema alias', aliasSource, aliasMarkers, true],
      [
        'importer fields mutation',
        `${aliasSource}\nconst { fields } = Alias; export const mutate = () => { fields.operation = foreign; };`,
        aliasMarkers,
        false,
      ],
      [
        'importer fields escape',
        `${aliasSource}\nconst { fields } = Alias; export const leak = () => consume(fields);`,
        aliasMarkers,
        false,
      ],

      [
        'imported owner mutation',
        aliasSource,
        `${aliasMarkers}\nexport const mutate = () => { DirectSchema.fields.operation = foreign; };`,
        false,
      ],
      [
        'imported owner fields escape',
        aliasSource,
        `${aliasMarkers}\nconst { fields } = DirectSchema; export const leak = () => consume(fields);`,
        false,
      ],

      [
        'computed projection',
        source.replace('marker.fields.consumerModuleId', "marker['fields'].consumerModuleId"),
        markers,
        false,
      ],
      ['executable projection', source.replace(digestField, 'inputDigest: acquireAuthority(),'), markers, false],
      [
        'getter projection',
        source.replace(digestField, 'get inputDigest() { return acquireAuthority(); },'),
        markers,
        false,
      ],
      ['ambient capture', source.replace(digestField, 'inputDigest: process.env.DIGEST,'), markers, false],
      ['foreign schema', source, markers.replace("from 'effect'", "from './foreign-effect.ts'"), false],
      [
        'descriptor getter',
        source,
        markers.replace("operation: Schema.Literal('READ')", 'get operation() { return acquireAuthority(); }'),
        false,
      ],
      ['descriptor mutation', source, `${markers}\nexport const mutate = () => { MarkerSchema.members = []; };`, false],
      [
        'descriptor alias mutation',
        source,
        `${markers}\nconst alias = MarkerSchema; export const mutate = () => { alias.members = []; };`,
        false,
      ],
      ['descriptor escape', source, `${markers}\nexport const leak = () => consume(MarkerSchema);`, false],
      [
        'destructured member mutation',
        source,
        `${markers}\nconst { members } = MarkerSchema; const [member] = members; export const mutate = () => { member.fields.allowedFields = foreign; };`,
        false,
      ],
      [
        'destructured fields escape',
        source,
        `${markers}\nconst { members } = MarkerSchema; const [member] = members; const { fields } = member; export const leak = () => consume(fields);`,
        false,
      ],

      [
        'shadowed projection',
        `${source}\nexport class Shadow { static { const intentFields = () => acquireAuthority(); const x = Schema.Struct({ ...intentFields(marker) }); } }`,
        markers,
        false,
      ],
      [
        'fake argument',
        `${source.replace('intentFields(marker)', 'intentFields(fakeMarker)')}\nconst fakeMarker = { get fields() { return acquireAuthority(); } };`,
        markers,
        false,
      ],
      [
        'foreign omit',
        source.replace(
          "import { Schema, Struct } from 'effect';",
          "import { Schema } from 'effect'; import { Struct } from './foreign-effect.ts';",
        ),
        markers,
        false,
      ],
      [
        'dynamic omit keys',
        source.replace(
          "Struct.omit(ProjectedSchema.fields, ['operation'])",
          'Struct.omit(ProjectedSchema.fields, omitFields)',
        ),
        markers,
        false,
      ],
      [
        'fake omit receiver',
        `${source.replace('Struct.omit(ProjectedSchema.fields', 'Struct.omit(fakeFields.fields')}\nconst fakeFields = { get fields() { return acquireAuthority(); } };`,
        markers,
        false,
      ],
    ] as const) {
      yield* write(root, sourceFile, current);
      yield* write(root, markerFile, descriptor);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? `${name}: ${Cause.pretty(result.cause)}` : name).toBe(
        allowed,
      );
    }
  }),
);

for (const [binding, subpath, allowed] of [
  ['CatalogSelectionWithQuantitySchema', CATALOG_SELECTION_CONTRACT_SUBPATH, true],
  ['CatalogSelectionSchema', 'catalog-selection', true],
  ['CatalogResourceRefSchema', 'catalog-resource-reference', true],
  ['privateCatalogDispatch', CATALOG_SELECTION_CONTRACT_SUBPATH, false],
] as const) {
  it.live(`checks actual Catalog selection source and dependency chain for ${binding}`, () =>
    Effect.gen(function* actualCatalogSelectionPublication() {
      const root = yield* makeActualCatalogSelectionFixture();
      const original = yield* Effect.promise(() => readFile(path.join(root, CATALOG_SELECTION_CONTRACT), 'utf-8'));
      yield* write(
        root,
        CATALOG_SELECTION_CONTRACT,
        `${original}\nexport const privateCatalogDispatch = () => globalThis;\n`,
      );
      yield* write(
        root,
        'apps/shell-super-app/src/catalog-selection-consumer.ts',
        `import { ${binding} } from '@app/catalog-selection-contracts/${subpath}';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(allowed);
    }),
  );
}

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
