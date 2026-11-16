import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Array as EffectArray, Cause, Effect, Exit, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { validateGatewayIssuerEntrypoints } from '../check-module-entrypoint-boundaries.mts';
import { gatewayContextAuthorizationEntrypoints } from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  hasGeneratedActionClientPublication,
  hasOwnerLocalReadServiceFactory,
  hasNativeHttpActionMount,
  ownerActionClientPublication,
  hasPublishedGeneratedContractShim,
  hasGeneratedGovernedServerContract,
} from '../generated-governed-http-boundary.mts';
import {
  hasGeneratedGovernedClientContract,
  hasGeneratedModuleApiReadContract,
  hasGeneratedModuleApiContract,
  generatedModuleApiEntrypointReference,
  hasGeneratedSourceHeader,
} from '../generated-module-api-boundary.mts';
import {
  assertPublishedOutboxContractSource,
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
  publishedResourceRefContractExports,
  resolvePublishedContractModuleId,
} from '../published-outbox-contracts.mts';
import {
  ACTION_FILE,
  ACTION_HEADER_FOR_TEST,
  APP_PACKAGE_LINK_DIRECTORY,
  ARCHIVE_ORGANIZATION_DECLARATION,
  AUTHENTICATE_PRINCIPAL_BINDING,
  AUTHORIZATION_VALUE,
  AUTHORIZATION_VALUE_TAIL,
  BOUNDARY_FIXTURE_INVENTORY,
  BOUNDARY_FIXTURE_SHELL_ID,
  BOUNDARY_FIXTURE_SHELL_PATH,
  BOUNDARY_FIXTURE_TOPOLOGY,
  CANONICAL_LOADER_FIXTURE,
  CANONICAL_MODULE_CLIENT_LOADER,
  CANONICAL_MODULE_LOADER,
  CANONICAL_MODULE_ROUTE,
  CANONICAL_ROUTE_SOURCE,
  CATALOG_SELECTION_CONTRACT,
  CATALOG_SELECTION_CONTRACT_SUBPATH,
  CLIENT_CONFIG_DECLARATION,
  CONNECTED_ENTRYPOINT_PROPERTY,
  CORE_RUNTIME_SOURCE_IMPORT,
  CORRELATION_VALUE,
  CORRELATION_VALUE_TAIL,
  CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH,
  DEFAULT_API_PREFIX,
  DEFAULT_API_PREFIX_TAIL,
  EARLY_FAILURE,
  ENGAGEMENT_ACTIONS,
  ENGAGEMENT_ACTION_DIRECTORY,
  ENGAGEMENT_ACTION_FILE,
  ENGAGEMENT_REGISTRATION_FILE,
  ENGAGEMENT_REJECTION,
  EXPECTED_EFFECT_FAILURE,
  EngagementInventorySchema,
  FAKE_CORE_SOURCE_IMPORT,
  FAKE_HTTP_SOURCE_IMPORT,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  GATEWAY_BYPASS_MARKER,
  GATEWAY_CONTRACT_FILE,
  GATEWAY_IMPORT,
  GATEWAY_INVOKE_MARKER,
  GOVERNED_SEARCH_HEADER,
  IMPORTED_MODULE_KEY_PROPERTY,
  INVENTORY_API_PREFIX,
  INVENTORY_AUDIENCE_OPTION,
  INVENTORY_BACKEND_CONTRACT,
  INVENTORY_CONTRACT_IMPORT,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_MODULE_ID,
  INVENTORY_OWNER_PATH,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_REGISTRATION_PATH,
  INVENTORY_RUNTIME_ID,
  INVENTORY_SCHEMA_CONSUMER,
  INVENTORY_VERTICAL_PATH,
  MANIFEST_SEARCH_END,
  MARKET_DEPLOYMENT_ID,
  MODULE_API_HEADER,
  MODULE_API_KIND,
  NATIVE_HTTP_SOURCE_IMPORT,
  OPTIONS_CALL_TAIL,
  PARTIAL_FAILURE,
  PARTY_API_CLIENT_EXPORT,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_CLIENT_SOURCE_PATH,
  PARTY_DEPLOYMENT_ID,
  PARTY_MODULE_ID,
  PARTY_OUTBOX_SPECIFIER,
  PARTY_PACKAGE_NAME,
  PARTY_RESOURCE_SOURCE_PATH,
  PAYLOAD_SCHEMA_PROPERTY,
  PORTAL_PUBLIC_CLIENT,
  PORTAL_PUBLIC_SCHEMA,
  PORTAL_SHELL_CONSUMER,
  PRICING_HANDLER_PATH,
  PRICING_SHARED_API_PATH,
  PRIVATE_ROUTE_METADATA,
  PROTECTED_AUTHORIZATION_SOURCE,
  PUBLIC_AUTHORIZATION_SOURCE,
  READ_ACCESS_SOURCE,
  RENAMED_CONTRACTS_PACKAGE,
  RESERVE_CLIENT_RELATIVE_IMPORT,
  RESERVE_PUBLISHED_SOURCE,
  RESOLVED_FOREIGN_HANDLER,
  RESOLVED_OWNER_CONSUMER,
  SCHEMA_DISPATCH_IMPORTS,
  SCHEMA_VERSION_ONE,
  SHARED_CONTRACTS_PACKAGE_JSON_PATH,
  SHARED_CONTRACTS_WORKSPACE_NAME,
  SHARED_CONTRACTS_WORKSPACE_PATH,
  SHARED_GATEWAY_FACTORY,
  SHARED_PROBLEM_DETAILS_SOURCE_PATH,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  STOCK_LIST_API_BINDING,
  STOCK_LIST_CLIENT_CONTRACT_IMPORT,
  STOCK_LIST_PUBLISHED_SOURCE,
  STOCK_LIST_READ_BINDING,
  STOCK_LIST_READ_FILE,
  STOCK_LIST_SERVER_CONTRACT_IMPORT,
  STOCK_LIST_STEM,
  UNMOUNTED_ISSUER_ENDPOINT,
  UNRECOGNIZED_ISSUER_PATH,
  UNUSED_NATIVE_API_DECLARATION,
  VERTICALS_WORKSPACE_DECLARATION,
  WORKER_FILE,
  WORKSPACE_DEPENDENCY_VERSION,
  WORKSPACE_MANIFEST_PATH,
  acceptsTypedGtinBinding,
  assertPublishedPartyUsage,
  assertRejectedSources,
  checkModuleEntrypointBoundaries,
  generatedPartyActionHttpClientSource,
  generatedPartyCommandClientSource,
  generatedPartyDetailClientSource,
  governedClientFixture,
  governedServerFixture,
  makeActualCatalogSelectionFixture,
  makeFixture,
  makePortalPublicRoleFixture,
  makeResolvedOwnerFixture,
  makeSelectedInventoryFixture,
  moduleContractFixture,
  moduleReadFixture,
  partyClientSource,
  partyManifestSource,
  partyOutboxSource,
  partyPackage,
  partyResourceSource,
  problemKinds,
  protectedAuthorizationSource,
  validAction,
  violations,
  write,
  writeEngagementLifecycleFixture,
  writeGovernedModuleApi,
} from './module-entrypoint-boundaries.fixture.mts';

it('accepts a typed Codesmith Action binding but rejects spoofed or mismatched registration types', () => {
  const binding = `export const confirmGtinAction: ActionRegistration<
    typeof ConfirmGtinPayloadSchema,
    typeof ConfirmGtinResultSchema,
    typeof GtinActionErrorSchema,
    Readonly<Record<string, never>>,
    'commerce.catalog',
    GtinServices
  > = defineAction(
    { domainErrorSchema: GtinActionErrorSchema, payloadSchema: ConfirmGtinPayloadSchema,
      resultSchema: ConfirmGtinResultSchema, actionKey: 'commerce.catalog.confirm-gtin' },
    handleConfirmGtin, gtinServicesForScope,
  );`;
  expect(acceptsTypedGtinBinding(binding)).toBe(true);
  expect(
    acceptsTypedGtinBinding(
      binding.replace(
        'GtinServices\n  > = defineAction(',
        'GtinServices, GtinHandlerRequirements\n  > = defineAction(',
      ),
    ),
  ).toBe(true);
  expect(acceptsTypedGtinBinding(binding.replace("'commerce.catalog'", "'other.module'"))).toBe(false);
  expect(acceptsTypedGtinBinding(binding.replace('typeof ConfirmGtinResultSchema', 'typeof WrongResultSchema'))).toBe(
    false,
  );
  expect(
    acceptsTypedGtinBinding(
      binding.replace('domainErrorSchema: GtinActionErrorSchema', 'domainErrorSchema: WrongErrorSchema'),
    ),
  ).toBe(false);
  expect(acceptsTypedGtinBinding(`const decoy = \`${binding}\`;`)).toBe(false);
});

it('recognizes real provenance comments after import sorting and rejects string decoys', () => {
  const header = GOVERNED_SEARCH_HEADER;
  expect(hasGeneratedSourceHeader(`${header}export const provider = true;`, header)).toBe(true);
  expect(
    hasGeneratedSourceHeader(`import { Effect } from "effect";\n${header}export const provider = true;`, header),
  ).toBe(true);
  expect(hasGeneratedSourceHeader(`const decoy = \`${header}\`;`, header)).toBe(false);
  expect(hasGeneratedSourceHeader(`function decoy() {\n${header}}`, header)).toBe(false);
  expect(hasGeneratedSourceHeader(header.replace('search-provider', 'report'), header)).toBe(false);
});

it.effect('governed clients retain every boundary check across formatter trailing-comma choices', () =>
  Effect.sync(() => {
    const expectation = {
      authorizedOperation: 'loadInventoryItemsClientWithAuthorization',
      defaultApiPrefix: INVENTORY_API_PREFIX,
      endpointGroup: 'inventoryItemsSearch',
      generatedHeader: GOVERNED_SEARCH_HEADER,
      invocationKind: 'provider',
      ownerApiValue: 'InventoryItemsSearchApi',
      ownerContractImport: INVENTORY_CONTRACT_IMPORT,
      publicOperation: 'loadInventoryItemsClient',
    } as const;
    const source = governedClientFixture({
      ...expectation,
      apiValue: expectation.ownerApiValue,
      clientHelper: 'inventoryItemsClient',
      contractImport: expectation.ownerContractImport,
    });
    const withoutCallTrailingCommas = source.replaceAll(/,\s*(?=\))/gu, '');
    expect(hasGeneratedGovernedClientContract(withoutCallTrailingCommas, expectation)).toBe(true);
    for (const invalidTarget of [
      source.replace('baseUrl: apiBaseUrl', "baseUrl: '/inventory-stock-api'"),
      source.replace('baseUrl: apiBaseUrl,\n      compositionRevision,', 'baseUrl: apiBaseUrl,'),
      source.replace(
        '...options,\n      baseUrl: apiBaseUrl,\n      compositionRevision,',
        'baseUrl: apiBaseUrl,\n      compositionRevision,\n      ...options,',
      ),
      source.replace('(credential, { apiBaseUrl, compositionRevision })', '(credential)'),
    ]) {
      expect(hasGeneratedGovernedClientContract(invalidTarget, expectation)).toBe(false);
    }
    expect(
      hasGeneratedGovernedClientContract(
        withoutCallTrailingCommas.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
        expectation,
      ),
    ).toBe(false);
    for (const [helperComma, objectComma, callComma] of [
      [false, false, false],
      [false, false, true],
      [false, true, false],
      [false, true, true],
      [true, false, false],
      [true, false, true],
      [true, true, false],
      [true, true, true],
    ] as const) {
      const variant = source
        .replace(
          'options: InventoryItemsClientOptions,\n)',
          `options: InventoryItemsClientOptions${helperComma ? ',' : ''}\n)`,
        )
        .replace('requestCorrelation,\n    }', `requestCorrelation${objectComma ? ',' : ''}\n    }`)
        .replace(OPTIONS_CALL_TAIL, `options${callComma ? ',' : ''}\n  );`);
      expect(hasGeneratedGovernedClientContract(variant, expectation)).toBe(true);
      expect(
        hasGeneratedGovernedClientContract(variant.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL), expectation),
      ).toBe(false);
      expect(
        hasGeneratedGovernedClientContract(
          variant.replace(`      requestCorrelation${objectComma ? ',' : ''}`, CORRELATION_VALUE_TAIL),
          expectation,
        ),
      ).toBe(false);
      expect(
        hasGeneratedGovernedClientContract(variant.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL), expectation),
      ).toBe(false);
    }
  }),
);

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

it('governed servers bind the trusted handler, authentication, registration, and problem schemas', () => {
  const exportedName = 'stockListReadApiLive';
  const source = governedServerFixture({
    apiValue: 'StockListApi',
    contractImport: STOCK_LIST_SERVER_CONTRACT_IMPORT,
    exportedName,
    generatedHeader: MODULE_API_HEADER,
    group: 'stockList',
    readValue: 'stockListRead',
  });
  const closedApi = `export const api = HttpApi.make('InventoryApi')
// <generated-governed-http-api-additions>
// </generated-governed-http-api-additions>
.annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' })
.pipe(identity);`;
  const accepts = (candidate: string, api = closedApi): boolean =>
    hasGeneratedGovernedServerContract(candidate, exportedName, api);
  expect(accepts(source)).toBe(true);
  const withExportedDomainMapper = source
    .replace(
      "import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';",
      "import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';\nimport { Schema } from 'effect';",
    )
    .replace(
      "StockListInternalProblemSchema } from '../shared/apis/stock-list.ts';",
      "StockListInternalProblemSchema, StockListDomainPolicyProblemSchema } from '../shared/apis/stock-list.ts';",
    )
    .replace(
      'const problems = makeGovernedReadProblems({',
      `export const mapStockListDomainError = (
  error: unknown,
): typeof StockListDomainPolicyProblemSchema.Type => {
  Schema.is(Schema.Unknown)(error);
  return StockListDomainPolicyProblemSchema.make({ detail: 'Rejected' });
};
const problems = makeGovernedReadProblems({`,
    )
    .replace(
      '    authenticatePrincipal: authenticateOperationPrincipal,',
      '    authenticatePrincipal: authenticateOperationPrincipal,\n    mapDomainError: mapStockListDomainError,',
    );
  expect(accepts(withExportedDomainMapper)).toBe(true);
  expect(accepts(source.replace(MODULE_API_HEADER, ''))).toBe(false);
  expect(accepts(source.replace('    problems,', '    problems: problems,'))).toBe(true);
  for (const [expected, replacement] of [
    [AUTHENTICATE_PRINCIPAL_BINDING, 'authenticatePrincipal: forgedPrincipal'],
    [STOCK_LIST_READ_BINDING, 'registration: otherRead'],
    [STOCK_LIST_READ_BINDING, 'registration: stockListRead || otherRead'],
    [AUTHENTICATE_PRINCIPAL_BINDING, 'authenticatePrincipal: authenticateOperationPrincipal || forgedPrincipal'],
    ['    problems,', '    problems, extra: true,'],
    ["'@app/core-runtime/http/governed-read'", "'./fake-handler.ts'"],
    ["'./auth/action-principal.ts'", "'./fake-auth.ts'"],
    ['authentication: StockListAuthenticationProblemSchema', 'authentication: { make: () => ({ status: 200 }) }'],
    [
      'unavailable: StockListUnavailableProblemSchema',
      'unavailable: { make: () => ({ status: 503, retryable: false }) }',
    ],
    ['authentication: StockListAuthenticationProblemSchema', 'authentication: OtherProblemSchema'],
    ['    problems,', '    problems, ...overrides,'],
  ] as const) {
    expect(accepts(source.replace(expected, replacement)), expected).toBe(false);
  }
  expect(
    accepts(
      `${source.replace(
        'makeGovernedReadHttpHandler({',
        'unusedHelper({',
      )}\nconst unused = makeGovernedReadHttpHandler({});`,
    ),
  ).toBe(false);
});

it.live('accepts governed generated Actions, pages, Workers, catalogs, and route manifests', () =>
  Effect.gen(function* testEffect3() {
    const root = yield* makeFixture();
    yield* checkModuleEntrypointBoundaries(root);
  }),
);

it.live('confines native Federation imports, including aliases and dynamic imports, to governed Shell edges', () =>
  Effect.gen(function* nativeFederationBoundary() {
    const root = yield* makeFixture();
    const sources = [
      "import { loadRemote as resolveRemote } from '@module-federation/enhanced/runtime'; resolveRemote('inventory/Widget');",
      "import { getInstance } from '@module-federation/modern-js-v3/runtime'; getInstance()?.loadRemote('inventory/Widget');",
      "import * as federation from '@module-federation/runtime'; federation.loadRemote('inventory/Widget');",
      "const federation = import('@module-federation/runtime-tools');",
      "const { loadRemote: resolveRemote } = require('@module-federation/runtime'); resolveRemote('inventory/Widget');",
      "export { createInstance } from '@module-federation/runtime-core';",
      "import { createLazyComponent } from '@module-federation/bridge-react';",
      "federation.preloadRemote([{ nameOrAlias: 'inventory' }]);",
      "federation.registerRemotes([{ name: 'inventory', entry: 'https://inventory.example/mf-manifest.json' }]);",
    ];
    yield* assertRejectedSources(
      root,
      'apps/shell-super-app/src/native-remote.ts',
      sources,
      /native Federation runtime imports.*approved Shell module-entrypoint loader/u,
    );
    yield* write(root, 'apps/shell-super-app/src/native-remote.ts', 'export const presentation = true;');
    yield* write(root, 'apps/shell-super-app/src/routes/module-entrypoint-loader.ts', sources[0] ?? '');
    yield* write(root, 'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx', sources[1] ?? '');
    yield* checkModuleEntrypointBoundaries(root);
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

it.live('requires the generic canonical route to retain private metadata and the Shell authentication gate', () =>
  Effect.gen(function* canonicalRouteBoundary() {
    const root = yield* makeFixture();
    yield* assertRejectedSources(
      root,
      CANONICAL_MODULE_ROUTE,
      [
        CANONICAL_ROUTE_SOURCE.replace(PRIVATE_ROUTE_METADATA, 'public: true'),
        CANONICAL_ROUTE_SOURCE.replace('indexable: false', 'indexable: true'),
        CANONICAL_ROUTE_SOURCE.replace("canonicalPath: '/*'", "canonicalPath: '/contacts'"),
        CANONICAL_ROUTE_SOURCE.replace(PRIVATE_ROUTE_METADATA, 'public: false, public: true'),
        CANONICAL_ROUTE_SOURCE.replace(PRIVATE_ROUTE_METADATA, '...overrides, public: false'),
        CANONICAL_ROUTE_SOURCE.replace(PRIVATE_ROUTE_METADATA, "public: false, ['public']: true"),
        CANONICAL_ROUTE_SOURCE.replace("kind: 'authenticated_principal'", "kind: 'public'"),
      ],
      /generic canonical module route must/u,
    );
    yield* write(root, CANONICAL_MODULE_ROUTE, CANONICAL_ROUTE_SOURCE);
    yield* checkModuleEntrypointBoundaries(root);
    yield* Effect.promise(() => rm(path.join(root, CANONICAL_MODULE_LOADER)));
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(
      /provide its generic canonical module route and loader/u,
    );
    yield* write(root, CANONICAL_MODULE_LOADER, CANONICAL_LOADER_FIXTURE);
    yield* Effect.promise(() => rm(path.join(root, CANONICAL_MODULE_CLIENT_LOADER)));
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toContain(CANONICAL_MODULE_CLIENT_LOADER);
  }),
);

it.live('advances past a hash in a regular expression without skipping boundary checks', () =>
  Effect.gen(function* regexScannerControl() {
    const root = yield* makeFixture();
    const file = 'apps/shell-super-app/src/hex.ts';
    const validSource = 'export const isHex = (value: string) => /^#[0-9a-fA-F]{6}$/u.test(value);';
    yield* write(root, file, validSource);
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(root, file, `${validSource}\ngetActionHandler(registration);`);
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(
      /private handler accessors.*module-state gate/u,
    );
  }),
);

it.live(
  'resolves the actual Manage admission Action owner constant only through its exact owner-local static import',
  () =>
    Effect.gen(function* importedMarketActionOwner() {
      const root = yield* makeFixture();
      const owner = 'verticals/commerce-market-catalog';
      const action = `${owner}/src/actions/manage-market-retirement-admission.action.ts`;
      const support = `${owner}/src/actions/market-action-support.ts`;
      const workspace = path.resolve(import.meta.dirname, '../..');
      const [actionSource, supportSource] = yield* Effect.all([
        Effect.promise(() => readFile(path.join(workspace, action), 'utf-8')),
        Effect.promise(() => readFile(path.join(workspace, support), 'utf-8')),
      ]);
      yield* write(
        root,
        BOUNDARY_FIXTURE_TOPOLOGY,
        JSON.stringify({
          shell: { id: BOUNDARY_FIXTURE_SHELL_ID, path: BOUNDARY_FIXTURE_SHELL_PATH },
          verticals: [
            { id: INVENTORY_DEPLOYMENT_ID, path: INVENTORY_VERTICAL_PATH },
            { id: MARKET_DEPLOYMENT_ID, path: owner },
          ],
        }),
      );
      yield* write(root, `${owner}/package.json`, JSON.stringify({ name: '@app/commerce-market-catalog' }));
      yield* write(root, action, actionSource);
      yield* write(root, support, supportSource);
      expect(actionSource).toContain(
        "import { MODULE_KEY, marketDataAccessEvidence } from './market-action-support.ts';",
      );
      expect(actionSource).toContain(IMPORTED_MODULE_KEY_PROPERTY);
      yield* checkModuleEntrypointBoundaries(root);
      const inventory = Schema.decodeUnknownSync(EngagementInventorySchema)(
        yield* Effect.promise(() => readFile(path.join(root, BOUNDARY_FIXTURE_INVENTORY), 'utf-8')),
      );
      expect(
        inventory.entries.filter(
          (entry) => entry.entrypointKey === 'commerce.market-catalog.manage-market-retirement-admission',
        ),
      ).toEqual([
        {
          authorization: { kind: 'protected' },
          deployment: MARKET_DEPLOYMENT_ID,
          entrypointKey: 'commerce.market-catalog.manage-market-retirement-admission',
          owner: 'commerce.market-catalog',
          surface: 'action',
        },
      ]);

      const exported = "export const MODULE_KEY = 'commerce.market-catalog' as const;";
      expect(supportSource).toContain(exported);
      for (const invalid of [
        supportSource.replace(exported, "export const MODULE_KEY = 'other.owner' as const;"),
        supportSource.replace(exported, 'export const MODULE_KEY = selectOwner();'),
        supportSource.replace(exported, "export let MODULE_KEY = 'commerce.market-catalog';"),
        supportSource.replace(exported, "const MODULE_KEY = 'commerce.market-catalog' as const;"),
        supportSource.replace(exported, `const decoy = \`${exported}\`;`),
        supportSource.replace(exported, `/* ${exported} */`),
        supportSource.replace(exported, `function decoy() { ${exported} }`),
        supportSource.replace(exported, `${exported}\n${exported}`),
        supportSource.replace(exported, "export { MODULE_KEY } from './other-owner.ts';"),
      ]) {
        expect(invalid).not.toBe(supportSource);
        yield* write(root, support, invalid);
        expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(ENGAGEMENT_REJECTION);
      }
      yield* write(root, support, supportSource);
      const foreign = 'verticals/other-owner/src/actions/market-action-support.ts';
      yield* write(root, foreign, supportSource);
      for (const invalid of [
        actionSource.replace("from './market-action-support.ts'", "from './missing.ts'"),
        actionSource.replace(
          "from './market-action-support.ts'",
          "from '../../../other-owner/src/actions/market-action-support.ts'",
        ),
        actionSource.replace(
          'import { MODULE_KEY, marketDataAccessEvidence }',
          'import type { MODULE_KEY, marketDataAccessEvidence }',
        ),
        `${actionSource}\nimport { MODULE_KEY } from './market-action-support.ts';`,
        actionSource.replace(IMPORTED_MODULE_KEY_PROPERTY, "moduleKey: MODULE_KEY + '.wrong',"),
        actionSource.replace(IMPORTED_MODULE_KEY_PROPERTY, 'moduleKey: UNRESOLVED_OWNER,'),
        actionSource.replace('= defineAction(', '= (MODULE_KEY: string) => defineAction('),
        actionSource.replace('= defineAction(', '= ({ MODULE_KEY }: { readonly MODULE_KEY: string }) => defineAction('),
        actionSource.replace("role: 'action',", "role: 'worker',"),
        actionSource.replace('defineTenantModuleEntrypoint({', 'defineSystemModuleEntrypoint({'),
      ]) {
        expect(invalid).not.toBe(actionSource);
        yield* write(root, action, invalid);
        expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(ENGAGEMENT_REJECTION);
      }
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

it.live(
  'rejects shared Action identity, schema, import, shadowing, decoy and override tampering',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture(true);
    yield* writeEngagementLifecycleFixture(root);
    const source = yield* Effect.promise(() => readFile(path.join(root, ENGAGEMENT_ACTION_FILE), 'utf-8'));
    const mutations = [
      ["'./engagement-lifecycle-registration.ts'", "'../other/engagement-lifecycle-registration.ts'"],
      ['import { engagementLifecycleRegistration }', 'import { engagementLifecycleRegistration as counterfeit }'],
      ["'party.registry.archive-organization-engagement'", "'party.registry.unarchive-organization-engagement'"],
      ['// @ontos-action-owner party.registry', '// @ontos-action-owner other.owner'],
      ['// @ontos-action-slug archive-organization-engagement', '// @ontos-action-slug archive-person-engagement'],
      [
        'payloadSchema: OrganizationEngagementLifecyclePayloadSchema',
        'payloadSchema: OrganizationEngagementProfileSchema',
      ],
      [
        'resultSchema: OrganizationEngagementProfileSchema',
        'resultSchema: OrganizationEngagementLifecyclePayloadSchema',
      ],
      [
        '...engagementLifecycleRegistration<OrganizationEngagementLifecyclePayload>',
        '...engagementLifecycleRegistration<PersonEngagementLifecyclePayload>',
      ],
      ["'../../shared/domain/engagement-profile.ts'", "'../../shared/domain/counterfeit.ts'"],
      [ARCHIVE_ORGANIZATION_DECLARATION, 'export const unarchiveOrganizationEngagementAction'],
      [PAYLOAD_SCHEMA_PROPERTY, 'resourcePermission: undefined, payloadSchema:'],
      [PAYLOAD_SCHEMA_PROPERTY, 'entrypoint: otherEntrypoint, payloadSchema:'],
      [PAYLOAD_SCHEMA_PROPERTY, '...overrides, payloadSchema:'],
      ['...engagementLifecycleRegistration', '...overrides, ...engagementLifecycleRegistration'],
      [
        ARCHIVE_ORGANIZATION_DECLARATION,
        'const engagementLifecycleRegistration = () => ({}); export const archiveOrganizationEngagementAction',
      ],
      [
        ARCHIVE_ORGANIZATION_DECLARATION,
        `const decoy = defineTenantModuleEntrypoint({ access: 'write', authorization: { kind: 'protected' }, entrypointKey: 'party.registry.archive-organization-engagement', moduleKey: 'party.registry', role: 'action' }); export const archiveOrganizationEngagementAction`,
      ],
      ['import { defineAction,', 'import { defineAction as unsafeAction,'],
      ['accessDeclaration: {', 'resourcePermission: undefined, accessDeclaration: {'],
      ['accessDeclaration: {', 'accessDeclaration: {}, accessDeclaration: {'],
      [
        'resultSchema: OrganizationEngagementProfileSchema',
        'resultSchema: OrganizationEngagementProfileSchema, authorization: { kind: "public" }',
      ],
    ] as const;
    yield* assertRejectedSources(
      root,
      ENGAGEMENT_ACTION_FILE,
      [
        ...mutations.map(([before, after]) => source.replace(before, after)),
        `${source.replaceAll('engagementLifecycleRegistration', 'counterfeitRegistration')}
const decoy = defineTenantModuleEntrypoint({ access: 'write', authorization: { kind: 'protected' }, entrypointKey: 'party.registry.archive-organization-engagement', moduleKey: 'party.registry', role: 'action' });`,
      ],
      ENGAGEMENT_REJECTION,
    );
  }),
);

it.live(
  'rejects altered shared Action helper governance and constructor provenance',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture(true);
    yield* writeEngagementLifecycleFixture(root);
    const source = yield* Effect.promise(() => readFile(path.join(root, ENGAGEMENT_REGISTRATION_FILE), 'utf-8'));
    const mutations = [
      ["'@app/core-runtime'", "'@app/counterfeit-runtime'"],
      ['defineTenantModuleEntrypoint', 'defineSystemModuleEntrypoint'],
      ["kind: 'protected'", PUBLIC_AUTHORIZATION_SOURCE],
      [protectedAuthorizationSource, "authorization: { kind: 'protected', provisioning: 'explicit' },"],
      ["access: 'write'", READ_ACCESS_SOURCE],
      ["role: 'action'", "role: 'api'"],
      ["moduleKey: 'party.registry'", "moduleKey: 'other.owner'"],
      ['entrypointKey: actionKey', "entrypointKey: 'party.registry.wrong'"],
      ["legalEntityScope: 'required'", "legalEntityScope: 'optional'"],
      ["idempotency: 'required'", "idempotency: 'optional'"],
      [protectedAuthorizationSource, "authorization: { kind: 'protected', permission: 'read' },"],
      ['recordKey: payload.profileRef.resourceId', "recordKey: 'other-resource'"],
      ["'./engagement-lifecycle-handler.ts'", "'./counterfeit-handler.ts'"],
      ['domainErrorSchema: EngagementLifecycleErrorSchema', 'domainErrorSchema: Schema.Never'],
      ["schemaVersion: '1'", "...overrides, schemaVersion: '1'"],
      ['policies: []', 'policies: [,]'],
      [
        'export const engagementLifecycleRegistration',
        'const defineActionResourcePermission = () => undefined; export const engagementLifecycleRegistration',
      ],
    ] as const;
    yield* assertRejectedSources(
      root,
      ENGAGEMENT_REGISTRATION_FILE,
      mutations.map(([before, after]) => source.replace(before, after)),
      ENGAGEMENT_REJECTION,
    );
    yield* write(root, ENGAGEMENT_REGISTRATION_FILE, '');
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(ENGAGEMENT_REJECTION),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
  }),
);

it.live(
  'rejects shared Action registrations relocated outside their exact owner and action file',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture(true);
    yield* writeEngagementLifecycleFixture(root);
    const source = yield* Effect.promise(() => readFile(path.join(root, ENGAGEMENT_ACTION_FILE), 'utf-8'));
    const wrongFile = `${ENGAGEMENT_ACTION_DIRECTORY}/archive-other-engagement.action.ts`;
    yield* write(root, wrongFile, source);
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(ENGAGEMENT_REJECTION),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.promise(() => rm(path.join(root, wrongFile)));
    yield* write(root, ACTION_FILE, source);
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(ENGAGEMENT_REJECTION),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
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

it.live(
  'accepts only a complete generated governed module API seam',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(
      root,
      STOCK_LIST_READ_FILE,
      moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList').replace(
        READ_ACCESS_SOURCE,
        "access: 'historical_read'",
      ),
    );
    yield* checkModuleEntrypointBoundaries(root);
    const sharedApiPath = 'verticals/inventory-stock/shared/api.ts';
    const manifestPath = 'verticals/inventory-stock/vertical.manifest.ts';
    const registrationPath = INVENTORY_REGISTRATION_PATH;
    const sharedApi = yield* Effect.promise(() => readFile(path.join(root, sharedApiPath), 'utf-8'));
    const manifest = yield* Effect.promise(() => readFile(path.join(root, manifestPath), 'utf-8'));
    const registration = yield* Effect.promise(() => readFile(path.join(root, registrationPath), 'utf-8'));
    yield* write(
      root,
      sharedApiPath,
      `${sharedApi.replace(STOCK_LIST_API_BINDING, '')}
const decoyApi = HttpApi.make('DecoyApi').addHttpApi(StockListApi);`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, sharedApiPath, sharedApi);
    yield* write(
      root,
      sharedApiPath,
      sharedApi.replace(STOCK_LIST_API_BINDING, `${STOCK_LIST_API_BINDING}${STOCK_LIST_API_BINDING}`),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, sharedApiPath, sharedApi);
    yield* write(
      root,
      sharedApiPath,
      `${sharedApi}\nexport const decoyApi = HttpApi.make('DecoyApi').addHttpApi(StockListApi);`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, sharedApiPath, sharedApi);
    const handlerRootPath = 'verticals/inventory-stock/api/index.ts';
    const handlerRoot = yield* Effect.promise(() => readFile(path.join(root, handlerRootPath), 'utf-8'));
    yield* write(
      root,
      handlerRootPath,
      handlerRoot
        .replace(
          '// </generated-governed-http-handler-imports>',
          "import { missingDetailReadApiLive } from './missing-detail-read-server.ts';\n// </generated-governed-http-handler-imports>",
        )
        .replace(
          '// </generated-governed-http-handler-layers>',
          'missingDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),\n// </generated-governed-http-handler-layers>',
        ),
    );
    const secondContractPath = 'verticals/inventory-stock/shared/apis/missing-detail.ts';
    const moduleApiHeader = MODULE_API_HEADER;
    yield* write(
      root,
      sharedApiPath,
      sharedApi
        .replace(
          "import { StockListApi } from './apis/stock-list.ts';",
          "import { MissingDetailApi } from './apis/missing-detail.ts';\nimport { StockListApi } from './apis/stock-list.ts';",
        )
        .replace(STOCK_LIST_API_BINDING, `${STOCK_LIST_API_BINDING}.addHttpApi(MissingDetailApi)`),
    );
    yield* write(
      root,
      manifestPath,
      manifest
        .replace(
          "import { StockListApi } from './shared/apis/stock-list.ts';",
          "import { MissingDetailApi } from './shared/apis/missing-detail.ts';\nimport { StockListApi } from './shared/apis/stock-list.ts';",
        )
        .replace(
          "    'stock-list': StockListApi,",
          "    'missing-detail': MissingDetailApi,\n    'stock-list': StockListApi,",
        ),
    );
    yield* write(
      root,
      registrationPath,
      registration.replace(
        "    'stock-list': () => import('./src/api/stock-list-client.ts'),",
        "    'missing-detail': () => import('./src/api/missing-detail-client.ts'),\n    'stock-list': () => import('./src/api/stock-list-client.ts'),",
      ),
    );
    yield* write(root, secondContractPath, moduleContractFixture('missing-detail', 'MissingDetail', 'missingDetail'));
    yield* write(
      root,
      'verticals/inventory-stock/src/api/missing-detail.read.ts',
      moduleReadFixture('missing-detail', 'MissingDetail', 'missingDetail'),
    );
    yield* write(
      root,
      'verticals/inventory-stock/src/api/missing-detail-client.ts',
      governedClientFixture({
        apiValue: 'MissingDetailApi',
        authorizedOperation: 'executeMissingDetailWithAuthorization',
        clientHelper: 'missingDetailClient',
        contractImport: '../../shared/apis/missing-detail.ts',
        endpointGroup: 'missingDetail',
        generatedHeader: moduleApiHeader,
        invocationKind: MODULE_API_KIND,
        publicOperation: 'executeMissingDetail',
      }),
    );
    yield* write(
      root,
      'verticals/inventory-stock/api/missing-detail-read-server.ts',
      governedServerFixture({
        apiValue: 'MissingDetailApi',
        contractImport: '../shared/apis/missing-detail.ts',
        exportedName: 'missingDetailReadApiLive',
        generatedHeader: moduleApiHeader,
        group: 'missingDetail',
        readValue: 'missingDetailRead',
      }),
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* Effect.promise(() => rm(path.join(root, secondContractPath)));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, sharedApiPath, sharedApi);
    yield* write(root, manifestPath, manifest);
    yield* write(root, registrationPath, registration);
    yield* Effect.promise(() => rm(path.join(root, 'verticals/inventory-stock/src/api/missing-detail.read.ts')));
    yield* Effect.promise(() => rm(path.join(root, 'verticals/inventory-stock/src/api/missing-detail-client.ts')));
    yield* Effect.promise(() => rm(path.join(root, 'verticals/inventory-stock/api/missing-detail-read-server.ts')));
    yield* write(root, handlerRootPath, handlerRoot);
    yield* write(
      root,
      manifestPath,
      `${manifest.replace("'stock-list': StockListApi,", "'stock-list': OtherApi,")}
const decoy = { 'stock-list': StockListApi };`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, manifestPath, manifest);
    yield* write(
      root,
      registrationPath,
      `${registration.replace("import('./src/api/stock-list-client.ts')", "import('./src/api/other-client.ts')")}
const decoy = { 'stock-list': () => import('./src/api/stock-list-client.ts') };`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, registrationPath, registration);
    yield* write(
      root,
      registrationPath,
      registration.replace(
        '    // </generated-module-registration-apis>',
        `    ['orphan']: () => import('./src/api/stock-list-client.ts'),
    // </generated-module-registration-apis>`,
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, registrationPath, registration);
    yield* write(
      root,
      registrationPath,
      registration
        .replace("    'stock-list': () => import('./src/api/stock-list-client.ts'),\n", '')
        .replace(
          '    // </generated-module-registration-search>',
          "    'stock-list': () => import('./src/api/stock-list-client.ts'),\n    // </generated-module-registration-search>",
        ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, registrationPath, registration);
    const gatewayPath = 'verticals/inventory-stock/src/api/action-gateway.ts';
    const gateway = yield* Effect.promise(() => readFile(path.join(root, gatewayPath), 'utf-8'));
    yield* assertRejectedSources(
      root,
      gatewayPath,
      [
        gateway.replace(
          'export const operationGateway = makeOperationGateway();',
          "namespace Decoy { export const operationGateway = makeOperationGateway(); }\nconst spoof = 'export const operationGateway = actionGateway';",
        ),
        gateway.replace(
          'export const operationGateway = makeOperationGateway();',
          "export const operationGateway = { invoke: (attempt) => attempt('Bearer cached') };",
        ),
        gateway.replace(SHARED_GATEWAY_FACTORY, "makeSharedOperationGateway('wrong-audience', acquire)"),
        gateway.replace(
          '(acquire: OperationGatewayIssuer = issueGatewayContext)',
          '(issueGatewayContext: OperationGatewayIssuer)',
        ),
        `${gateway}
Object.assign(operationGateway, {
  invoke: <Success, Failure>(attempt: ActionGatewayAttempt<Success, Failure>) =>
    attempt('Bearer cached'),
});`,
      ],
      /module APIs require an approved Codesmith generator/u,
    );
    yield* write(root, gatewayPath, gateway);
    yield* write(
      root,
      registrationPath,
      registration.replace(
        '    // </generated-module-registration-apis>',
        `    'stale': () => import('./src/api/stock-list-client.ts'),
    // </generated-module-registration-apis>`,
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, registrationPath, registration);
    yield* write(
      root,
      INVENTORY_REGISTRATION_PATH,
      `export const inventoryStockRegistration = { entrypoints: { api: {
  // <generated-module-registration-apis>
  'stock-list': () => import('./src/api/stock-list-client.ts'),
  // </generated-module-registration-apis>
}, reports: {
  // <generated-module-registration-reports>
  // </generated-module-registration-reports>
}, search: {
  // <generated-module-registration-search>
  // </generated-module-registration-search>
} } };
// <generated-public-component-registrations>
// </generated-public-component-registrations>
// <generated-search-registrations>
// </generated-search-registrations>
// <generated-report-registrations>
// </generated-report-registrations>`,
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(
      root,
      'verticals/inventory-stock/api/stock-list-read-server.ts',
      `${MODULE_API_HEADER}export const server = true;`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
  }),
);

it.live(
  'rejects generated governed clients that bypass the shared client runtime seam',
  Effect.fn(function* mergedScenario4() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const readPath = STOCK_LIST_READ_FILE;
    const validRead = yield* Effect.promise(() => readFile(path.join(root, readPath), 'utf-8'));
    yield* assertRejectedSources(
      root,
      readPath,
      [
        validRead.replace(
          'policies: []',
          "policies: [], ...{ entrypoint: attackerEntrypoint, legalEntityScope: 'required' }",
        ),
        validRead.replace("owningModuleKey: 'inventory.stock'", "owningModuleKey: 'attacker.module'"),
        validRead.replace("readKey: 'inventory.stock.api.stock-list'", "readKey: 'attacker.read'"),
        validRead.replace(SCHEMA_VERSION_ONE, "schemaVersion: '2'"),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
    yield* write(root, readPath, validRead);
    const clientPath = 'verticals/inventory-stock/src/api/stock-list-client.ts';
    const validClient = yield* Effect.promise(() => readFile(path.join(root, clientPath), 'utf-8'));
    const deadCanonicalHelperClient = validClient
      .replace(
        'const stockListClient = (',
        `const bypassClient = (...arguments_: readonly unknown[]) =>
  Effect.tryPromise(() => fetch('/bypass'));

const stockListClient = (`,
      )
      .replace(
        'stockListClient(Redacted.make(credential), requestCorrelation, options).pipe(',
        'bypassClient(Redacted.make(credential), requestCorrelation, options).pipe(',
      );
    expect(deadCanonicalHelperClient).toMatch(/bypassClient\(Redacted\.make\(credential\)/u);
    expect(deadCanonicalHelperClient).not.toMatch(/stockListClient\(Redacted\.make\(credential\)/u);
    const nestedCanonicalHelperClient = validClient
      .replace(
        '  options: StockListClientOptions,\n) =>',
        `  options: StockListClientOptions,
) => {
  const deadCanonicalClient = () => {`,
      )
      .replace(
        '\n  );\nexport const executeStockListWithAuthorization',
        `
  };
  return Effect.tryPromise(() => fetch('/bypass'));
};
export const executeStockListWithAuthorization`,
      );
    expect(nestedCanonicalHelperClient).toMatch(/const deadCanonicalClient = \(\) => \{/u);
    const decoyOperationClient = `${validClient
      .replaceAll('executeStockListWithAuthorization', 'decoyWithAuthorization')
      .replaceAll('executeStockList', 'decoy')}
export const executeStockListWithAuthorization = (payload, credential, requestCorrelation, options) =>
  stockListClient(Redacted.make(credential), requestCorrelation, options).pipe(
    Effect.flatMap((client) => client.stockList.execute({ payload })),
  );
export const executeStockList = (payload, requestCorrelation, options) =>
  executeStockListWithAuthorization(payload, 'Bearer bypass', requestCorrelation, options);`;
    const shadowedGatewayClient = validClient.replace(
      'export const executeStockList = (\n  payload:',
      'export const executeStockList = (\n  operationGateway: unknown,\n  payload:',
    );
    const bypassedEndpointClient = validClient.replace(
      'Effect.flatMap((client) => client.stockList.execute({ payload }))',
      'Effect.flatMap(() => Effect.succeed({ bypass: true }))',
    );
    const shadowedFactoryClient = validClient.replace(
      CLIENT_CONFIG_DECLARATION,
      `  const makeGovernedEffectBffClient = () => Effect.succeed({ bypass: true });
  const clientConfig = {`,
    );
    const invalidClients = [
      validClient.replace("from '@app/shared-contracts/client-runtime'", "from '@modern-js/bff-effect/effect-client'"),
      validClient.replace(GATEWAY_INVOKE_MARKER, GATEWAY_BYPASS_MARKER),
      validClient.replace(AUTHORIZATION_VALUE, "'x-authorization': Redacted.value(credential)"),
      validClient.replace(CORRELATION_VALUE, "'x-trace-id': requestCorrelation"),
      validClient.replace(
        CORRELATION_VALUE,
        "      'x-correlation-id': requestCorrelation,\n      ...({ authorization: 'Bearer bypass', 'x-correlation-id': 'wrong' }),",
      ),
      validClient.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
      validClient.replace(CORRELATION_VALUE, CORRELATION_VALUE_TAIL),
      validClient.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL),
      validClient.replace(
        `    ${OPTIONS_CALL_TAIL}`,
        "  };\n  clientConfig.transportHeaders.authorization = 'Bearer bypass';\n  clientConfig.transportHeaders['x-correlation-id'] = 'wrong';\n  return makeGovernedEffectBffClient(",
      ),
      validClient.replace(STOCK_LIST_CLIENT_CONTRACT_IMPORT, '../../shared/api.ts'),
      validClient.replace('./action-gateway.ts', './cached-credential-gateway.ts'),
      validClient.replace('api: StockListApi', 'api: OtherApi'),
      validClient.replace(
        CLIENT_CONFIG_DECLARATION,
        "  return makeGovernedEffectBffClient({ api: StockListApi, defaultApiPrefix: '/inventory-stock-api', transportHeaders: {} });\n  const clientConfig = {",
      ),
      deadCanonicalHelperClient,
      nestedCanonicalHelperClient,
      decoyOperationClient,
      shadowedGatewayClient,
      bypassedEndpointClient,
      shadowedFactoryClient,
      validClient.replace(
        'export const executeStockListWithAuthorization',
        `Object.assign(operationGateway, { invoke: (attempt) => attempt('Bearer cached') });
export const executeStockListWithAuthorization`,
      ),
      validClient.replace(
        CLIENT_CONFIG_DECLARATION,
        `  const { makeGovernedEffectBffClient } = factoryBox;
  const clientConfig = {`,
      ),
      validClient.replace(
        GATEWAY_IMPORT,
        `import '../../api/index.ts';
${GATEWAY_IMPORT}`,
      ),
      validClient.replace(
        GATEWAY_IMPORT,
        `import '../db/repository.ts';
${GATEWAY_IMPORT}`,
      ),
      validClient.replace(
        "import { Effect, Redacted } from 'effect';",
        "import { Effect, Redacted, runSync } from 'effect';",
      ),
      validClient.replace(
        '  options: StockListClientOptions,\n)',
        "  options: StockListClientOptions,\n  unused = fetch('/bypass'),\n)",
      ),
      validClient.replace(
        '  ...[credential, requestCorrelation, options = {}]: StockListAuthorizedInvocation\n)',
        "  ...[credential, requestCorrelation, options = {}]: StockListAuthorizedInvocation,\n  unused = fetch('/bypass'),\n)",
      ),
      `${validClient}
export const executeStockListBypass = () => Effect.tryPromise(() => fetch('/bypass'));`,
      `${validClient}
export interface BypassOptions { readonly enabled: boolean }`,
      `${validClient}
export function bypass() { return fetch('/bypass'); }`,
      `${validClient}
const bypass = () => fetch('/bypass');
export { bypass };`,
      `${validClient}
export * from '../db/repository.ts';`,
      `${validClient}
export { repository } from '../db/repository.ts';`,
      `${validClient}
fetch('/bypass');`,
      validClient.replace(MODULE_API_HEADER, ''),
      `${validClient.replace(GATEWAY_INVOKE_MARKER, GATEWAY_BYPASS_MARKER)}
const spoof = 'operationGateway.invoke transportHeaders: authorization: x-correlation-id:';`,
      `${validClient.replace(CORRELATION_VALUE, '      transportMetadata: requestCorrelation,')}
// operationGateway.invoke transportHeaders: authorization: 'x-correlation-id':`,
    ];
    yield* assertRejectedSources(
      root,
      clientPath,
      invalidClients,
      /module APIs require an approved Codesmith generator/u,
    );
    const contractPath = 'verticals/inventory-stock/shared/apis/stock-list.ts';
    const validContract = yield* Effect.promise(() => readFile(path.join(root, contractPath), 'utf-8'));
    yield* assertRejectedSources(
      root,
      contractPath,
      [
        ...problemKinds.map(([, suffix, status]) =>
          validContract.replace(`'StockList${suffix}Problem', ${status}`, `'StockList${suffix}Problem', 200`),
        ),
        validContract.replace(
          "makeRetryableProblemDetailsSchema('StockListUnavailableProblem'",
          "makeProblemDetailsSchema('StockListUnavailableProblem'",
        ),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
    yield* write(root, contractPath, validContract);
    yield* write(
      root,
      contractPath,
      validContract.replace(
        "HttpApi.make('StockListApi').add(HttpApiGroup.make('stockList').add(HttpApiEndpoint.post('execute', '/reads/stock-list', {})))",
        `HttpApi.make('StockListApi')
  .pipe((api) => {
    DecoyApi.add(HttpApiGroup.make('decoy'));
    return api;
  })
  .add(HttpApiGroup.make('stockList').add(HttpApiEndpoint.post('execute', '/reads/stock-list', {})))`,
      ),
    );
    yield* write(root, clientPath, validClient.replace('client.stockList.execute', 'client.decoy.execute'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(
      root,
      contractPath,
      `${validContract.replace(".add(HttpApiGroup.make('stockList').add(HttpApiEndpoint.post('execute', '/reads/stock-list', {})))", '')}
DecoyApi.add(HttpApiGroup.make('decoy'));`,
    );
    yield* write(root, clientPath, validClient.replace('client.stockList.execute', 'client.decoy.execute'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(
      root,
      contractPath,
      `namespace Decoy {
  export const StockListApi = HttpApi.make('Decoy').add(HttpApiGroup.make('decoy'));
}
${validContract}`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, contractPath, validContract);
    yield* write(root, clientPath, validClient);
    yield* assertRejectedSources(
      root,
      contractPath,
      [
        ...["HttpApi.make('StockListApi').add(OtherGroup)", "HttpApi.make('StockListApi').pipe(() => DecoyApi)"].map(
          (bypass) => validContract.replace("HttpApi.make('StockListApi')", bypass),
        ),
        validContract.replace("HttpApi.make('StockListApi')", "HttpApi.make('WrongApi')"),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
    yield* write(root, contractPath, validContract.replace("'/reads/stock-list'", "'/wrong-endpoint'"));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, contractPath, validContract);
    yield* write(root, clientPath, validClient);
    yield* write(root, contractPath, validContract.replace('})));', '}))).pipe(() => DecoyApi);'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, contractPath, validContract);
    yield* write(
      root,
      contractPath,
      validContract.replace(
        "HttpApiGroup.make('stockList')",
        "HttpApiGroup.make('stockList') ? DecoyGroup : OwnerGroup",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, contractPath, validContract);
    const sharedRootPath = `${INVENTORY_VERTICAL_PATH}/shared/api.ts`;
    const sharedRoot = yield* Effect.promise(() => readFile(path.join(root, sharedRootPath), 'utf-8'));
    yield* write(
      root,
      sharedRootPath,
      sharedRoot
        .replace("export const endpoint = HttpApiEndpoint.post('listStock', '/stock/list');\n", '')
        .replace(
          "import { HttpApi, HttpApiEndpoint } from 'effect/http-api';",
          "import { HttpApi } from 'effect/http-api';",
        ),
    );
    const providerHeader = `// @generated by OntOS Codesmith Governed Contribution v1
// @ontos-contribution-kind search-provider
`;
    const providerContractPath = 'verticals/inventory-stock/shared/apis/inventory-items-search.ts';
    const providerClientPath = 'verticals/inventory-stock/src/api/inventory-items-search-client.ts';
    const validProviderContract = `${providerHeader}export const InventoryItemsSearchApi = HttpApi.make('InventoryItemsSearchApi').add(HttpApiGroup.make('inventoryItemsSearch').add(HttpApiEndpoint.post('execute', '/inventory.stock/search/inventory-items', {})));`;
    const providerClient = governedClientFixture({
      apiValue: 'InventoryItemsSearchApi',
      authorizedOperation: 'loadInventoryItemsClientWithAuthorization',
      clientHelper: 'inventoryItemsClient',
      contractImport: INVENTORY_CONTRACT_IMPORT,
      endpointGroup: 'inventoryItemsSearch',
      generatedHeader: providerHeader,
      invocationKind: 'provider',
      publicOperation: 'loadInventoryItemsClient',
    });
    yield* write(root, providerContractPath, validProviderContract);
    yield* write(root, providerClientPath, providerClient);
    yield* write(
      root,
      'verticals/inventory-stock/src/search/inventory-items.provider.ts',
      `${providerHeader}export const inventoryItemsEntrypoint = defineTenantModuleEntrypoint({ access: 'read', authorization: { kind: 'protected' }, entrypointKey: 'inventory.stock.search.inventory-items', moduleKey: 'inventory.stock', role: 'search' });
export const inventoryItemsRead = defineRead({ accessKind: 'search', entrypoint: inventoryItemsEntrypoint, legalEntityScope: 'required', owningModuleKey: 'inventory.stock', readKey: 'inventory.stock.search.inventory-items', schemaVersion: '1' });`,
    );
    yield* write(
      root,
      'verticals/inventory-stock/api/inventory-items-search-server.ts',
      governedServerFixture({
        apiValue: 'InventoryItemsSearchApi',
        contractImport: '../shared/apis/inventory-items-search.ts',
        exportedName: 'inventoryItemsReadApiLive',
        generatedHeader: providerHeader,
        group: 'inventoryItemsSearch',
        readValue: 'inventoryItemsRead',
      }),
    );
    const providerManifestPath = 'verticals/inventory-stock/vertical.manifest.ts';
    const providerRegistrationPath = INVENTORY_REGISTRATION_PATH;
    const providerManifest = yield* Effect.promise(() => readFile(path.join(root, providerManifestPath), 'utf-8'));
    const providerRegistration = yield* Effect.promise(() =>
      readFile(path.join(root, providerRegistrationPath), 'utf-8'),
    );
    yield* write(
      root,
      providerManifestPath,
      providerManifest
        .replace(
          MANIFEST_SEARCH_END,
          `    { key: 'inventory.stock.inventory-items', owningModuleId: 'inventory.stock' },
    // </generated-module-manifest-search>`,
        )
        .replace(
          '      // </generated-module-shell-search>',
          `      { contributionKey: 'inventory.stock.search.inventory-items', entrypoint: { access: 'read', authorization: { kind: 'protected' }, entrypointKey: 'inventory.stock.search.inventory-items', moduleKey: 'inventory.stock', role: 'search', scope: 'tenant' }, searchKey: 'inventory.stock.inventory-items' },
      // </generated-module-shell-search>`,
        ),
    );
    yield* write(
      root,
      providerRegistrationPath,
      providerRegistration.replace(
        '    // </generated-module-registration-search>',
        `    'inventory-items': () => import('./src/api/inventory-items-search-client.ts'),
    // </generated-module-registration-search>`,
      ),
    );
    yield* checkModuleEntrypointBoundaries(root);
    const originalProviderManifest = yield* Effect.promise(() =>
      readFile(path.join(root, providerManifestPath), 'utf-8'),
    );
    const originalProviderRegistration = yield* Effect.promise(() =>
      readFile(path.join(root, providerRegistrationPath), 'utf-8'),
    );
    const ownerHeader =
      '// @generated by OntOS Codesmith Module Contract v1\n// @ontos-deployment-app-id inventory-stock\n// @ontos-module-id inventory.stock\n';
    const declarationPath = `${INVENTORY_VERTICAL_PATH}/vertical.runtime-declaration.ts`;
    const uiFields = originalProviderManifest.slice(
      originalProviderManifest.indexOf('  reports: ['),
      originalProviderManifest.indexOf('  shellContributions: {'),
    );
    const shellFields = originalProviderManifest.slice(
      originalProviderManifest.indexOf('  shellContributions: {'),
      originalProviderManifest.lastIndexOf('};'),
    );
    const apiFields = originalProviderManifest.slice(
      originalProviderManifest.indexOf('  api: {'),
      originalProviderManifest.indexOf('  reports: ['),
    );
    const splitManifest = `${ownerHeader}import { defineOntosModuleManifest } from '@app/core-runtime';
import { inventoryStockRuntimeManifest } from './vertical.runtime-declaration.ts';
export const inventoryStockManifest = defineOntosModuleManifest({
  ...inventoryStockRuntimeManifest,
  activation: {},
  publicSurface: { ...inventoryStockRuntimeManifest.publicSurface, components: [], events: [], resourceTypes: [],
${uiFields}
  },
});`;
    const splitRegistration = `${ownerHeader}import { defineVerticalRuntimeRegistration } from '@app/core-runtime';
import { inventoryStockManifest } from './vertical.manifest.ts';
import { inventoryStockRuntimeDeclaration } from './vertical.runtime-declaration.ts';
${originalProviderRegistration.replace('export const inventoryStockRegistration = { entrypoints:', 'export const inventoryStockRegistration = defineVerticalRuntimeRegistration({ ...inventoryStockRuntimeDeclaration, entrypoints:').replace('} };', '}, manifest: inventoryStockManifest });')}`;
    const splitDeclaration = `${ownerHeader}import { defineVerticalRuntimeRegistration } from '@app/core-runtime';
import type { VerticalRuntimeRegistrationInput } from '@app/core-runtime';
// <generated-module-manifest-imports>
import { StockListApi } from './shared/apis/stock-list.ts';
// </generated-module-manifest-imports>
// <generated-module-registration-imports>
// </generated-module-registration-imports>
export const inventoryStockRuntimeManifest: VerticalRuntimeRegistrationInput['manifest'] = {
  module: { id: 'inventory.stock' },
  publicSurface: {
    actions: [
      // <generated-module-manifest-actions>
      // </generated-module-manifest-actions>
    ],
${apiFields}${shellFields}
  },
};
export const inventoryStockRuntimeDeclaration: VerticalRuntimeRegistrationInput = {
  actions: inventoryStockRuntimeManifest.publicSurface.actions,
  manifest: inventoryStockRuntimeManifest,
  outboxWorkers: [
    // <generated-module-registration-workers>
    // </generated-module-registration-workers>
  ],
};
export const inventoryStockBackendRegistration = defineVerticalRuntimeRegistration(inventoryStockRuntimeDeclaration);`;
    yield* write(root, providerManifestPath, splitManifest);
    yield* write(root, providerRegistrationPath, splitRegistration);
    yield* write(root, declarationPath, splitDeclaration);
    yield* checkModuleEntrypointBoundaries(root);
    const shellStart = splitDeclaration.indexOf('// <generated-module-shell-search>');
    const shellEnd =
      splitDeclaration.indexOf('// </generated-module-shell-search>') + '// </generated-module-shell-search>'.length;
    const shellSlot = splitDeclaration.slice(shellStart, shellEnd);
    const shellContribution =
      "{ contributionKey: 'inventory.stock.search.inventory-items', entrypoint: { access: 'read', authorization: { kind: 'protected' }, entrypointKey: 'inventory.stock.search.inventory-items', moduleKey: 'inventory.stock', role: 'search', scope: 'tenant' }, searchKey: 'inventory.stock.inventory-items' }";
    const invalidSplitSources = [
      {
        declaration: splitDeclaration,
        manifest: splitManifest.replace(
          "from './vertical.runtime-declaration.ts'",
          "from '../foreign/vertical.runtime-declaration.ts'",
        ),
      },
      {
        declaration: splitDeclaration.replace(
          '// @ontos-module-id inventory.stock',
          '// @ontos-module-id foreign.module',
        ),
        manifest: splitManifest,
      },
      { declaration: splitDeclaration.replace('// <generated-module-shell-search>', ''), manifest: splitManifest },
      {
        declaration: `${splitDeclaration.replace(shellSlot, '')}\nconst displaced = [${shellSlot}];`,
        manifest: splitManifest,
      },
      {
        declaration: splitDeclaration.replace(shellContribution, `${shellContribution}, ${shellContribution}`),
        manifest: splitManifest,
      },
      {
        declaration: splitDeclaration.replace(
          "contributionKey: 'inventory.stock.search.inventory-items'",
          "contributionKey: 'foreign.module.search.inventory-items'",
        ),
        manifest: splitManifest,
      },
      {
        declaration: splitDeclaration.replace(
          shellContribution,
          shellContribution.replace("authorization: { kind: 'protected' }", "authorization: { kind: 'public' }"),
        ),
        manifest: splitManifest,
      },
    ];
    for (const invalid of invalidSplitSources) {
      expect(invalid.declaration !== splitDeclaration || invalid.manifest !== splitManifest).toBe(true);
      yield* write(root, providerManifestPath, invalid.manifest);
      yield* write(root, declarationPath, invalid.declaration);
      yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
        onFailure: (cause) =>
          expect(String(Cause.squash(cause))).toMatch(/generated (?:providers|search and report clients)/u),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
      expect(yield* Effect.promise(() => readFile(path.join(root, providerManifestPath), 'utf-8'))).toBe(
        invalid.manifest,
      );
      expect(yield* Effect.promise(() => readFile(path.join(root, declarationPath), 'utf-8'))).toBe(
        invalid.declaration,
      );
      expect(yield* Effect.promise(() => readFile(path.join(root, providerRegistrationPath), 'utf-8'))).toBe(
        splitRegistration,
      );
    }
    yield* write(root, providerManifestPath, originalProviderManifest);
    yield* write(root, providerRegistrationPath, originalProviderRegistration);
    yield* Effect.promise(() => rm(path.join(root, declarationPath)));
    yield* write(
      root,
      providerContractPath,
      validProviderContract.replace(
        "HttpApiGroup.make('inventoryItemsSearch').add(HttpApiEndpoint.post('execute', '/inventory.stock/search/inventory-items', {}))",
        "HttpApiGroup.make('inventoryItemsSearch').add(HttpApiEndpoint.post('execute', '/inventory.stock/search/inventory-items', {})).add(HttpApiEndpoint.post('bypass', '/bypass', {}))",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(
      root,
      providerContractPath,
      `${validProviderContract.replace('/inventory.stock/search/inventory-items', '/wrong-endpoint')}
const decoyGroup = HttpApiGroup.make('inventoryItemsSearch').add(HttpApiEndpoint.post('execute', '/inventory.stock/search/inventory-items', {}));`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerContractPath, validProviderContract);
    const validProviderManifest = yield* Effect.promise(() => readFile(path.join(root, providerManifestPath), 'utf-8'));
    yield* write(
      root,
      providerManifestPath,
      validProviderManifest.replace("owningModuleId: 'inventory.stock'", "owningModuleId: 'wrong.owner'").replace(
        MANIFEST_SEARCH_END,
        `    { key: 'inventory.stock.decoy', owningModuleId: 'inventory.stock' },
    // </generated-module-manifest-search>`,
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerManifestPath, validProviderManifest);
    yield* write(
      root,
      providerManifestPath,
      validProviderManifest.replace(
        "entrypointKey: 'inventory.stock.search.inventory-items'",
        "entrypointKey: 'inventory.stock.search.wrong'",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerManifestPath, validProviderManifest);
    yield* write(
      root,
      providerManifestPath,
      validProviderManifest.replace(
        MANIFEST_SEARCH_END,
        `    { key: 'wrong.module.orphan', owningModuleId: 'wrong.module' },
    // </generated-module-manifest-search>`,
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerManifestPath, validProviderManifest);
    yield* write(
      root,
      providerManifestPath,
      validProviderManifest.replace(
        "{ key: 'inventory.stock.inventory-items', owningModuleId: 'inventory.stock' }",
        "{ decoy: { owningModuleId: 'inventory.stock' }, key: 'inventory.stock.inventory-items', owningModuleId: 'wrong.owner' }",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerManifestPath, validProviderManifest);
    const providerServerPath = 'verticals/inventory-stock/api/inventory-items-search-server.ts';
    const validProviderServer = yield* Effect.promise(() => readFile(path.join(root, providerServerPath), 'utf-8'));
    yield* write(
      root,
      providerServerPath,
      `${validProviderServer.replace(
        AUTHENTICATE_PRINCIPAL_BINDING,
        'authenticatePrincipal: unverifiedPrincipal',
      )}\nconst unverifiedPrincipal = authenticateOperationPrincipal;`,
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerServerPath, validProviderServer);
    yield* assertRejectedSources(
      root,
      providerServerPath,
      [
        validProviderServer.replace(AUTHENTICATE_PRINCIPAL_BINDING, 'authenticatePrincipal: forgedPrincipal'),
        validProviderServer.replace('registration: inventoryItemsRead', 'registration: otherRead'),
        validProviderServer.replace('    problems,', '    problems, ...overrides,'),
        validProviderServer.replace('  api,', '  OtherApi,'),
        validProviderServer.replace("  'inventoryItemsSearch',", "  'wrongGroup',"),
        validProviderServer.replace("handlers.handle('execute',", "handlers.handle('bypass',"),
        `${validProviderServer.replace(
          'makeGovernedReadHttpHandler({',
          'bypass({',
        )}\nconst unused = makeGovernedReadHttpHandler({});`,
        validProviderServer.replace("'@app/core-runtime/http/governed-read'", "'./fake-handler.ts'"),
        validProviderServer.replace(
          'authentication: InventoryItemsProviderAuthenticationProblemSchema',
          'authentication: { make: () => ({ status: 200 }) }',
        ),
        validProviderServer.replace(
          'unavailable: InventoryItemsProviderUnavailableProblemSchema',
          'unavailable: { make: () => ({ status: 503, retryable: false }) }',
        ),
        `${validProviderServer}\nfetch('/bypass');`,
        validProviderServer.replace(providerHeader, `${providerHeader}import '../db/repository.ts';\n`),
        `${validProviderServer}\nexport * from '../db/repository.ts';`,
        `${validProviderServer}\nexport const bypass = () => fetch('/bypass');`,
      ],
      /generated search and report clients require the shared client runtime/u,
    );
    yield* write(root, providerServerPath, validProviderServer);
    yield* Effect.promise(() => rm(path.join(root, providerClientPath)));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerClientPath, providerClient);
    const validProviderRegistration = yield* Effect.promise(() =>
      readFile(path.join(root, providerRegistrationPath), 'utf-8'),
    );
    yield* write(
      root,
      providerRegistrationPath,
      validProviderRegistration.replace(
        './src/api/inventory-items-search-client.ts',
        './src/api/other-search-client.ts',
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerRegistrationPath, validProviderRegistration);
    yield* write(
      root,
      providerRegistrationPath,
      validProviderRegistration.replace(
        "'inventory-items': () => import('./src/api/inventory-items-search-client.ts'),",
        "'decoy': () => ({ 'inventory-items': () => import('./src/api/inventory-items-search-client.ts') }),",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerRegistrationPath, validProviderRegistration);
    yield* write(
      root,
      providerRegistrationPath,
      validProviderRegistration
        .replace("    'inventory-items': () => import('./src/api/inventory-items-search-client.ts'),\n", '')
        .replace(
          '    // </generated-module-registration-reports>',
          `    'inventory-items': () => import('./src/api/inventory-items-search-client.ts'),
    // </generated-module-registration-reports>`,
        ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerRegistrationPath, validProviderRegistration);
    yield* Effect.promise(() => rm(path.join(root, providerContractPath)));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerContractPath, validProviderContract);
    const providerSourcePath = 'verticals/inventory-stock/src/search/inventory-items.provider.ts';
    const validProviderSource = yield* Effect.promise(() => readFile(path.join(root, providerSourcePath), 'utf-8'));
    yield* write(
      root,
      providerSourcePath,
      validProviderSource.replace('export const inventoryItemsEntrypoint', 'const inventoryItemsEntrypoint'),
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* assertRejectedSources(
      root,
      providerSourcePath,
      [
        validProviderSource.replace("{ kind: 'protected' }", "{ kind: 'public' }"),
        validProviderSource.replace("owningModuleKey: 'inventory.stock'", "owningModuleKey: 'attacker.module'"),
        validProviderSource.replace("readKey: 'inventory.stock.search.inventory-items'", "readKey: 'attacker.read'"),
        validProviderSource.replace(SCHEMA_VERSION_ONE, "schemaVersion: '2'"),
      ],
      /generated search and report clients require the shared client runtime/u,
    );
    yield* write(root, providerSourcePath, validProviderSource);
    yield* write(
      root,
      providerSourcePath,
      validProviderSource.replace(
        SCHEMA_VERSION_ONE,
        "schemaVersion: '1', ...{ owningModuleKey: 'attacker.module', readKey: 'attacker.read' }",
      ),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerSourcePath, validProviderSource);
    yield* write(
      root,
      providerSourcePath,
      validProviderSource.replace(READ_ACCESS_SOURCE, "access: 'historical_read'"),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerSourcePath, validProviderSource);
    yield* Effect.all(
      [providerContractPath, providerClientPath, providerSourcePath, providerServerPath].map(
        Effect.fn(function* mergedScenario1(artifact) {
          return yield* Effect.promise(() => rm(path.join(root, artifact)));
        }),
      ),
      { concurrency: 'unbounded' },
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(
          /generated search and report clients require the shared client runtime/u,
        ),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, providerContractPath, validProviderContract);
    yield* write(root, providerClientPath, providerClient);
    yield* write(root, providerSourcePath, validProviderSource);
    yield* write(root, providerServerPath, validProviderServer);
    yield* assertRejectedSources(
      root,
      providerClientPath,
      [
        providerClient.replace('makeGovernedEffectBffClient', 'makeEffectHttpApiClient'),
        providerClient.replace(GATEWAY_INVOKE_MARKER, GATEWAY_BYPASS_MARKER),
        providerClient.replace(AUTHORIZATION_VALUE, "'x-authorization': Redacted.value(credential)"),
        providerClient.replace(CORRELATION_VALUE, "'x-trace-id': requestCorrelation"),
        providerClient.replace(
          CORRELATION_VALUE,
          "      'x-correlation-id': requestCorrelation,\n      ...({ authorization: 'Bearer bypass', 'x-correlation-id': 'wrong' }),",
        ),
        providerClient.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
        providerClient.replace(CORRELATION_VALUE, CORRELATION_VALUE_TAIL),
        providerClient.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL),
        providerClient.replace(INVENTORY_CONTRACT_IMPORT, '../../shared/api.ts'),
        providerClient.replace('api: InventoryItemsSearchApi', 'api: OtherApi'),
        providerClient.replace(providerHeader, ''),
      ],
      /generated search and report clients require the shared client runtime/u,
    );
    yield* write(root, providerClientPath, providerClient);
    const reportHeader = `// @generated by OntOS Codesmith Governed Contribution v1
// @ontos-contribution-kind report
`;
    const reportClientPath = 'verticals/inventory-stock/src/api/stock-levels-report-client.ts';
    const reportClient = governedClientFixture({
      apiValue: 'StockLevelsReportApi',
      authorizedOperation: 'loadStockLevelsClientWithAuthorization',
      clientHelper: 'stockLevelsClient',
      contractImport: '../../shared/apis/stock-levels-report.ts',
      endpointGroup: 'stockLevelsReport',
      generatedHeader: reportHeader,
      invocationKind: 'provider',
      publicOperation: 'loadStockLevelsClient',
    });
    yield* write(
      root,
      'verticals/inventory-stock/shared/apis/stock-levels-report.ts',
      `${reportHeader}export const StockLevelsReportApi = HttpApi.make('StockLevelsReportApi').add(HttpApiGroup.make('stockLevelsReport').add(HttpApiEndpoint.post('execute', '/inventory.stock/reports/stock-levels', {})));`,
    );
    yield* write(root, reportClientPath, reportClient);
    yield* write(
      root,
      'verticals/inventory-stock/src/reports/stock-levels.provider.ts',
      `${reportHeader}export const stockLevelsEntrypoint = defineTenantModuleEntrypoint({ access: 'read', authorization: { kind: 'authenticated_principal' }, entrypointKey: 'inventory.stock.report.stock-levels', moduleKey: 'inventory.stock', role: 'report' });
export const stockLevelsRead = defineRead({ accessKind: 'report', entrypoint: stockLevelsEntrypoint, legalEntityScope: 'required', owningModuleKey: 'inventory.stock', readKey: 'inventory.stock.report.stock-levels', schemaVersion: '1' });`,
    );
    yield* write(
      root,
      'verticals/inventory-stock/api/stock-levels-report-server.ts',
      governedServerFixture({
        apiValue: 'StockLevelsReportApi',
        contractImport: '../shared/apis/stock-levels-report.ts',
        exportedName: 'stockLevelsReadApiLive',
        generatedHeader: reportHeader,
        group: 'stockLevelsReport',
        readValue: 'stockLevelsRead',
      }),
    );
    const reportManifest = yield* Effect.promise(() => readFile(path.join(root, providerManifestPath), 'utf-8'));
    const reportRegistration = yield* Effect.promise(() =>
      readFile(path.join(root, providerRegistrationPath), 'utf-8'),
    );
    yield* write(
      root,
      providerManifestPath,
      reportManifest
        .replace(
          '    // </generated-module-manifest-reports>',
          `    { key: 'inventory.stock.stock-levels', owningModuleId: 'inventory.stock' },
    // </generated-module-manifest-reports>`,
        )
        .replace(
          '      // </generated-module-shell-reports>',
          `      { contributionKey: 'inventory.stock.report.stock-levels', entrypoint: { access: 'read', authorization: { kind: 'authenticated_principal' }, entrypointKey: 'inventory.stock.report.stock-levels', moduleKey: 'inventory.stock', role: 'report', scope: 'tenant' }, reportKey: 'inventory.stock.stock-levels' },
      // </generated-module-shell-reports>`,
        ),
    );
    yield* write(
      root,
      providerRegistrationPath,
      reportRegistration.replace(
        '    // </generated-module-registration-reports>',
        `    'stock-levels': () => import('./src/api/stock-levels-report-client.ts'),
    // </generated-module-registration-reports>`,
      ),
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* assertRejectedSources(
      root,
      reportClientPath,
      [
        reportClient.replace('defaultApiPrefix:', 'bypassedApiPrefix:'),
        reportClient.replace(
          `    ${OPTIONS_CALL_TAIL}`,
          "  };\n  clientConfig.transportHeaders.authorization = 'Bearer bypass';\n  return makeGovernedEffectBffClient(",
        ),
        reportClient.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
        reportClient.replace(CORRELATION_VALUE, CORRELATION_VALUE_TAIL),
        reportClient.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL),
      ],
      /generated search and report clients require the shared client runtime/u,
    );
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/package.json`,
      JSON.stringify({ modernjs: { appId: INVENTORY_RUNTIME_ID } }),
    );
    yield* write(
      root,
      BOUNDARY_FIXTURE_TOPOLOGY,
      JSON.stringify({
        shell: { id: BOUNDARY_FIXTURE_SHELL_ID, path: BOUNDARY_FIXTURE_SHELL_PATH },
        verticals: [{ id: INVENTORY_RUNTIME_ID, path: INVENTORY_VERTICAL_PATH }],
      }),
    );
    const routeMetadataPath = 'verticals/inventory-stock/src/routes/orders/route.meta.ts';
    const routeMetadata = yield* Effect.promise(() => readFile(path.join(root, routeMetadataPath), 'utf-8'));
    yield* write(root, routeMetadataPath, routeMetadata.replace(INVENTORY_DEPLOYMENT_ID, INVENTORY_RUNTIME_ID));
    yield* Effect.all(
      (
        [
          [clientPath, validClient],
          [providerClientPath, providerClient],
          [reportClientPath, reportClient],
        ] as const
      ).map(
        Effect.fn(function* mergedScenario2([relativePath, client]) {
          return yield* write(
            root,
            relativePath,
            client.replace(
              "defaultApiPrefix: '/inventory-stock-api'",
              `defaultApiPrefix: '/${INVENTORY_RUNTIME_ID}-api'`,
            ),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    yield* Effect.all(
      [
        'verticals/inventory-stock/api/auth/action-principal.ts',
        'verticals/inventory-stock/src/api/action-gateway.ts',
      ].map(
        Effect.fn(function* mergedScenario3(relativePath) {
          const boundary = yield* Effect.promise(() => readFile(path.join(root, relativePath), 'utf-8'));
          yield* write(
            root,
            relativePath,
            boundary
              .replace(
                '@ontos-action-boundary-owner inventory-stock',
                `@ontos-action-boundary-owner ${INVENTORY_RUNTIME_ID}`,
              )
              .replace(
                "ACTION_GATEWAY_AUDIENCE = 'inventory-stock'",
                `ACTION_GATEWAY_AUDIENCE = '${INVENTORY_RUNTIME_ID}'`,
              ),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    yield* checkModuleEntrypointBoundaries(root);
  }),
);

for (const violation of violations) {
  it.live(`rejects bypass ${violation.file}`, () =>
    Effect.gen(function* testEffect6() {
      const root = yield* makeFixture();
      yield* write(root, violation.file, violation.source);
      expect(
        ((error: Error) => {
          expect(error.message).toMatch(violation.expected);
          expect(error.message).toMatch(new RegExp(violation.file.replaceAll('.', String.raw`\.`), 'u'));
          expect(error.message).not.toMatch(/Widget =|endpoint =|registration =/u);
          return true;
        })(yield* Effect.flip(checkModuleEntrypointBoundaries(root))),
      ).toBe(true);
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

it('accepts an exact generated PartyRef contract import', () => {
  expect(() => assertPublishedPartyUsage()).not.toThrow();
  expect(publishedResourceRefContractExports(partyPackage)).toEqual(['./resources/party']);
});

it('rejects a ResourceRef contract with a spoofed Codesmith header', () => {
  expect(() =>
    assertPublishedPartyUsage({
      readExportSource: () => partyResourceSource.replace('OntOS Codesmith Resource v1', 'handmade'),
    }),
  ).toThrow(/must remain a generated schema-only ResourceRef contract/u);
});

it('rejects a ResourceRef export whose target is not its exact generated shared path', () => {
  expect(() =>
    assertPublishedPartyUsage({
      dependencyPackageJson: {
        ...partyPackage,
        exports: { './resources/party': './shared/domain/party.ts' },
      },
    }),
  ).toThrow(/not a published schema-only contract subpath/u);
});

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

it('rejects owner runtime imports hidden in a generated ResourceRef file', () => {
  expect(() =>
    assertPublishedPartyUsage({
      readExportSource: () =>
        `${partyResourceSource}import { repository } from '../../src/db/repository.ts';\nvoid repository;\n`,
    }),
  ).toThrow(/must remain a generated schema-only ResourceRef contract/u);
});

it('rejects a ResourceRef import without the consuming workspace dependency', () => {
  expect(() => assertPublishedPartyUsage({ dependencyDeclared: false })).toThrow(
    /must declare @app\/party-registry as a workspace dependency/u,
  );
});

it('rejects a ResourceRef import without the consuming TypeScript project reference', () => {
  expect(() => assertPublishedPartyUsage({ projectReferenceDeclared: false })).toThrow(
    /must project-reference @app\/party-registry/u,
  );
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

it('preserves existing exact Outbox contract dependency behavior', () => {
  expect(publishedOutboxContractExports(partyPackage)).toEqual(['./outbox/party-created']);
  expect(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: partyPackage,
      dependencyPackageName: PARTY_PACKAGE_NAME,
      moduleSpecifiers: [PARTY_OUTBOX_SPECIFIER],
    }),
  ).not.toThrow();
  expect(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: partyPackage,
      dependencyPackageName: PARTY_PACKAGE_NAME,
      moduleSpecifiers: ['@app/party-registry/resources/party'],
    }),
  ).toThrow(/not a published schema-only Outbox contract subpath/u);
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_OUTBOX_SPECIFIER],
      readExportSource: () => {
        throw new Error('Outbox source validation remains at its existing boundary');
      },
    }),
  ).not.toThrow();
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: ['@app/party-registry/outbox/not-published'],
    }),
  ).toThrow(/not a published schema-only contract subpath/u);
});

it('accepts an exact published Party Registry Effect client aggregate', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) => {
        if (target === PARTY_CLIENT_SOURCE_PATH) {
          return partyClientSource;
        }
        if (target === './src/api/party-detail-client.ts') {
          return generatedPartyDetailClientSource;
        }
        throw new Error(`unexpected provider source ${target}`);
      },
    }),
  ).not.toThrow();
});

it('rejects a published client export that points at backend implementation', () => {
  expect(() =>
    assertPublishedPartyUsage({
      dependencyPackageJson: {
        ...partyPackage,
        exports: {
          ...partyPackage.exports,
          [PARTY_API_CLIENT_EXPORT]: './api/index.ts',
        },
      },
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
    }),
  ).toThrow(/not a published schema-only contract subpath/u);
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

it('rejects an aggregate whose client leaf has no Codesmith metadata', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) =>
        target === PARTY_CLIENT_SOURCE_PATH ? partyClientSource : 'export const executePartyDetail = true;\n',
    }),
  ).toThrow(/must remain a generated public Effect client aggregate/u);
});

it('accepts an exact generated MicroVertical command client leaf', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) => {
        if (target === PARTY_CLIENT_SOURCE_PATH) {
          return `${partyClientSource}export * from './party-command-client.ts';\n`;
        }
        if (target === './src/api/party-detail-client.ts') {
          return generatedPartyDetailClientSource;
        }
        if (target === './src/api/party-command-client.ts') {
          return generatedPartyCommandClientSource;
        }
        throw new Error(`unexpected provider source ${target}`);
      },
    }),
  ).not.toThrow();
});

it('accepts an exactly owned filename-bound Action HTTP client leaf', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) => {
        if (target === PARTY_CLIENT_SOURCE_PATH) {
          return `${partyClientSource}export * from './archive-party-action-client.ts';\n`;
        }
        if (target === './src/api/archive-party-action-client.ts') {
          return generatedPartyActionHttpClientSource;
        }
        return generatedPartyDetailClientSource;
      },
    }),
  ).not.toThrow();
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

it('rejects a command client leaf whose generated owner marker names another deployment', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) => {
        if (target === PARTY_CLIENT_SOURCE_PATH) {
          return `${partyClientSource}export * from './party-command-client.ts';\n`;
        }
        if (target === './src/api/party-command-client.ts') {
          return generatedPartyCommandClientSource.replace(
            '@ontos-command-client-owner party-registry',
            '@ontos-command-client-owner contacts',
          );
        }
        return generatedPartyDetailClientSource;
      },
    }),
  ).toThrow(/must remain a generated public Effect client aggregate/u);
});

it('rejects API barrels and arbitrary client subpaths', () => {
  for (const specifier of [
    '@app/party-registry/api',
    '@app/party-registry/api/client/internal',
    '@app/party-registry/shared/api',
    '@app/party-registry/src/api/party-registry-client',
    '@app/party-registry/api/server',
  ]) {
    expect(() => assertPublishedPartyUsage({ moduleSpecifiers: [specifier] })).toThrow(
      /not a published schema-only contract subpath/u,
    );
  }
});

it('validates Outbox producer module identity when deployment appId differs from moduleId', () => {
  const moduleId = resolvePublishedContractModuleId({
    dependencyPackageJson: partyPackage,
    dependencyPackageName: PARTY_PACKAGE_NAME,
    expectedAppId: PARTY_DEPLOYMENT_ID,
    manifestSource: partyManifestSource,
  });
  expect(moduleId).toBe(PARTY_MODULE_ID);
  expect(() =>
    assertPublishedOutboxContractSource({
      moduleId,
      source: partyOutboxSource,
      specifier: PARTY_OUTBOX_SPECIFIER,
    }),
  ).not.toThrow();
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

it('rejects mismatched package and generated manifest ownership for published contracts', () => {
  expect(() =>
    resolvePublishedContractModuleId({
      dependencyPackageJson: { ...partyPackage, name: '@app/somewhere-else' },
      dependencyPackageName: PARTY_PACKAGE_NAME,
      expectedAppId: PARTY_DEPLOYMENT_ID,
      manifestSource: partyManifestSource,
    }),
  ).toThrow(/package and generated manifest ownership disagree/u);
});

it('keeps executable owner behavior out of published Outbox contracts', () => {
  expect(() =>
    assertPublishedOutboxContractSource({
      moduleId: PARTY_MODULE_ID,
      source: `${partyOutboxSource}import { handler } from '../../src/actions/create-party.action.ts';\n`,
      specifier: PARTY_OUTBOX_SPECIFIER,
    }),
  ).toThrow(/must remain a generated schema-only Outbox contract/u);
});

it.live('rejects route manifests that import missing or orphaned route metadata', () =>
  Effect.gen(function* testEffect8() {
    const root = yield* makeFixture();
    yield* write(
      root,
      'apps/shell-super-app/src/routes/ultramodern-route-metadata.ts',
      `import { routeMeta as route0 } from './orders/route.meta';`,
    );
    expect(String(yield* Effect.flip(checkModuleEntrypointBoundaries(root)))).toMatch(
      /manifest is stale \(missing: .*home\/route\.meta\.ts; orphaned: apps\/shell-super-app\/src\/routes\/orders\/route\.meta\.ts\)/u,
    );
  }),
);

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

it.live(
  'accepts private entrypoint declarations while requiring the registered read reference',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture();
    const readFilePath = STOCK_LIST_READ_FILE;
    yield* writeGovernedModuleApi(root);
    const source = yield* Effect.promise(() => readFile(path.join(root, readFilePath), 'utf-8'));
    const read = source.replace('export const stockListEntrypoint', 'const stockListEntrypoint');
    yield* write(root, readFilePath, read);
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(
      root,
      readFilePath,
      read.replace('entrypoint: stockListEntrypoint', 'entrypoint: unrelatedEntrypoint'),
    );
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/module APIs require/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
  }),
);

it.live(
  'shared issuer paths require the mounted gateway group and exact endpoint bindings',
  Effect.fn(function* mergedScenario1() {
    const root = yield* makeFixture();
    const contractFile = 'apps/shell-super-app/shared/api.ts';
    const gatewayFile = GATEWAY_CONTRACT_FILE;
    const source = yield* Effect.promise(() => readFile(new URL(`../../${contractFile}`, import.meta.url), 'utf-8'));
    const gatewaySource = yield* Effect.promise(() =>
      readFile(new URL(`../../${gatewayFile}`, import.meta.url), 'utf-8'),
    );
    yield* write(root, contractFile, source);
    yield* write(root, gatewayFile, gatewaySource);
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(root, contractFile, source.replace('.add(GatewayContextApiGroup)', '.add(UnrelatedApiGroup)'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/mounted gateway contract/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, contractFile, source);
  }),
);

for (const [before, after] of [
  [/post\(\s*'issueGatewayContext'/u, UNMOUNTED_ISSUER_ENDPOINT],
  [/post\(\s*'issueApiKeyGatewayContext'/u, UNMOUNTED_ISSUER_ENDPOINT],
  [/post\(\s*'issueDelegatedGatewayContext'/u, UNMOUNTED_ISSUER_ENDPOINT],
  ["'/auth/gateway-context'", UNRECOGNIZED_ISSUER_PATH],
  ["'/auth/api-key/gateway-context'", UNRECOGNIZED_ISSUER_PATH],
  ["'/auth/delegated/gateway-context'", UNRECOGNIZED_ISSUER_PATH],
  ["make('gatewayContext')", "make('unrelated')"],
  ['export const GatewayContextApiGroup =', 'export const UnmountedApiGroup ='],
] as const) {
  it.live(
    `rejects shared issuer binding tampering: ${before}`,
    Effect.fn(function* mergedScenario1() {
      const root = yield* makeFixture();
      const gatewayFile = GATEWAY_CONTRACT_FILE;
      const gatewaySource = yield* Effect.promise(() =>
        readFile(new URL(`../../${gatewayFile}`, import.meta.url), 'utf-8'),
      );
      expect(gatewaySource.replace(before, after)).not.toBe(gatewaySource);
      yield* write(root, gatewayFile, gatewaySource.replace(before, after));
      yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
        onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/mounted gateway contract/u),
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

for (const mutation of ['duplicate', 'unknown', 'credential', 'path', 'kind', 'missing'] as const) {
  it.effect(`rejects an invalid delegated issuer classification: ${mutation}`, () =>
    Effect.gen(function* invalidDelegatedClassification() {
      const sessionIssuer = gatewayContextAuthorizationEntrypoints.find(
        (issuer) => issuer.entrypointKey === 'shell.gateway-context.issue.session',
      );
      if (sessionIssuer === undefined) {
        throw new Error('The canonical session issuer is required by this fixture');
      }
      const issuers = gatewayContextAuthorizationEntrypoints.map((issuer) => {
        if (issuer.entrypointKey !== 'shell.gateway-context.issue.delegated') {
          return issuer;
        }
        return Match.value(mutation).pipe(
          Match.when('duplicate', () => sessionIssuer),
          Match.when('unknown', () => ({ ...issuer, entrypointKey: 'shell.gateway-context.issue.unknown' })),
          Match.when('credential', () => ({
            ...issuer,
            authorization: { credential: 'session', kind: 'capability_issuance' } as const,
          })),
          Match.when('path', () => ({ ...issuer, path: '/shell-super-app-api/auth/unrecognized/gateway-context' })),
          Match.when('kind', () => ({ ...issuer, authorization: { kind: 'public' } as const })),
          Match.when('missing', () => issuer),
          Match.exhaustive,
        );
      });
      const actual =
        mutation === 'missing'
          ? issuers.filter((issuer) => issuer.entrypointKey !== 'shell.gateway-context.issue.delegated')
          : issuers;
      yield* Effect.matchCause(validateGatewayIssuerEntrypoints(actual), {
        onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/must classify exactly/u),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
    }),
  );
}

for (const handler of ['issueGatewayContext', 'issueApiKeyGatewayContext', 'issueDelegatedGatewayContext'] as const) {
  it.live(`requires the mounted issuer handler rather than an identifier: ${handler}`, () =>
    Effect.gen(function* missingIssuerHandler() {
      const root = yield* makeFixture();
      yield* checkModuleEntrypointBoundaries(root);
      const runtimeFile = 'apps/shell-super-app/api/index.ts';
      const runtime = yield* Effect.promise(() => readFile(path.join(root, runtimeFile), 'utf-8'));
      const modifiedRuntime = runtime.replace(`.handle('${handler}'`, ".handle('unrelated'");
      yield* write(
        root,
        runtimeFile,
        `${modifiedRuntime}\nexport const ${handler} = true;\nexport const unusedText = ".handle('${handler}', unused)";\n// .handle('${handler}', unused)`,
      );
      yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
        onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/all three classified capability issuers/u),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
    }),
  );
}

for (const outcome of ['success', EARLY_FAILURE, PARTIAL_FAILURE, 'interruption'] as const) {
  it.live(`releases fixture directories after ${outcome} during initialization`, () =>
    Effect.gen(function* fixtureCleanupControl() {
      let directory = '';
      const failure = new Error('fixture initialization failed');
      const exit = yield* Effect.scoped(
        makeFixture(false, (root) =>
          Effect.gen(function* initializeFixtureControl() {
            directory = root;
            if (outcome === EARLY_FAILURE) {
              yield* Effect.fail(failure);
            }
            yield* write(root, 'partial.txt', 'partially initialized');
            if (outcome === PARTIAL_FAILURE) {
              yield* Effect.fail(failure);
            }
            if (outcome === 'interruption') {
              yield* Effect.interrupt;
            }
          }),
        ),
      ).pipe(Effect.exit);
      expect(directory).not.toBe('');
      expect(existsSync(directory)).toBe(false);
      expect(Exit.isSuccess(exit)).toBe(outcome === 'success');
      expect(Exit.hasInterrupts(exit)).toBe(outcome === 'interruption');
      if (outcome === EARLY_FAILURE || outcome === PARTIAL_FAILURE) {
        Exit.match(exit, {
          onFailure: (cause) => {
            expect(cause.reasons).toHaveLength(1);
            expect(Cause.squash(cause)).toBe(failure);
          },
          onSuccess: () => expect.unreachable('Expected fixture initialization to fail'),
        });
      }
    }),
  );
}

it('accepts the protected classification on a generated read and refuses any other kind', () => {
  const base = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
  expect(hasGeneratedModuleApiReadContract(base, INVENTORY_MODULE_ID, STOCK_LIST_STEM, { kind: 'protected' })).toBe(
    true,
  );
  // A protected read still has to be exactly `{ kind: 'protected' }`: the capability lives in the
  // access declaration, never in the classification (O62, CUTOVER-PLAN §4.2).
  expect(
    hasGeneratedModuleApiReadContract(
      base.replace(PROTECTED_AUTHORIZATION_SOURCE, "{ kind: 'protected', permission: 'module.access' }"),
      INVENTORY_MODULE_ID,
      STOCK_LIST_STEM,
      { kind: 'protected' },
    ),
  ).toBe(false);
  // The classification is a closed vocabulary: a read cannot be inventoried as anything else.
  for (const kind of ['public', 'authenticated_principal'] as const) {
    expect(hasGeneratedModuleApiReadContract(base, INVENTORY_MODULE_ID, STOCK_LIST_STEM, { kind })).toBe(false);
  }
});

it('accepts a protected read that decides itself without the legacy permission target (O62)', () => {
  const base = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
  expect(base).not.toContain('permissionTarget');
  expect(hasGeneratedModuleApiReadContract(base, INVENTORY_MODULE_ID, STOCK_LIST_STEM, { kind: 'protected' })).toBe(
    true,
  );
  // Negative control: a read on any other classification has to name the permission target it is
  // decided by, so the same descriptor without one is refused.
  const unprotected = base.replace(PROTECTED_AUTHORIZATION_SOURCE, "{ kind: 'authenticated_principal' }");
  expect(unprotected).not.toBe(base);
  expect(
    hasGeneratedModuleApiReadContract(unprotected, INVENTORY_MODULE_ID, STOCK_LIST_STEM, {
      kind: 'authenticated_principal',
    }),
  ).toBe(false);
});

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

it.live(
  'accepts canonical additional Layer provisions and rejects unsupported aliases without dropping the governed runtime',
  Effect.fn(function* canonicalLayerProvisionScenario() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const handlerPath = `${INVENTORY_VERTICAL_PATH}/api/index.ts`;
    const original = yield* Effect.promise(() => readFile(path.join(root, handlerPath), 'utf-8'));
    const first = 'stockListReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive))';
    const ownerProvision = 'Layer.provide(ownerDependenciesLive)';
    const provisioned = original.replace(
      first,
      `stockListReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive), ${ownerProvision})`,
    );
    yield* write(root, handlerPath, provisioned);
    yield* checkModuleEntrypointBoundaries(root);
    const invalidSources = [
      provisioned.replace(ownerProvision, 'GovernedReadLayer.provide(ownerDependenciesLive)'),
      provisioned.replace(ownerProvision, 'UnknownLayer.provide(ownerDependenciesLive)'),
      provisioned.replace(ownerProvision, 'Layer.provide(makeDependencies())'),
      provisioned.replace(ownerProvision, 'Layer.provide(ownerDependenciesLive, attacker)'),
      provisioned.replace(ownerProvision, 'ownerDependenciesLive'),
      provisioned.replace('GovernedReadLayer.provide(governedReadRuntimeLive), ', ''),
      provisioned.replace(
        'GovernedReadLayer.provide(governedReadRuntimeLive)',
        'Layer.provide(governedReadRuntimeLive)',
      ),
    ];
    yield* assertRejectedSources(root, handlerPath, invalidSources, /module APIs require/u);
  }),
);

it.live(
  'accepts the exact optional canonical request-schema error while retaining all required governed errors',
  Effect.fn(function* canonicalRequestSchemaProblemScenario() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const contractPath = `${INVENTORY_VERTICAL_PATH}/shared/apis/stock-list.ts`;
    const original = yield* Effect.promise(() => readFile(path.join(root, contractPath), 'utf-8'));
    const canonicalName = 'RequestSchemaProblemSchema';
    const factoryImport =
      "import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';\n";
    const canonicalImport = `import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema, ${canonicalName} } from '@app/shared-contracts/problem-details';\n`;
    const withError = original.replace('error: [', `error: [${canonicalName}, `);
    const withCanonical = withError.replace(factoryImport, canonicalImport);
    yield* write(root, contractPath, withCanonical);
    yield* checkModuleEntrypointBoundaries(root);
    const invalidSources = [
      withError,
      withCanonical.replace(canonicalImport, `${factoryImport}import { ${canonicalName} } from './fake-problem.ts';\n`),
      withCanonical.replace(
        canonicalImport,
        `${factoryImport}import type { ${canonicalName} } from '@app/shared-contracts/problem-details';\n`,
      ),
      withCanonical.replace(canonicalImport, `${factoryImport}const ${canonicalName} = fakeProblem;\n`),
      `${withCanonical}\nfunction shadow(${canonicalName}) {}`,
      `${withCanonical}\nfunction shadow({error: [${canonicalName}]}) {}`,
      `${withCanonical}\n[{error: [${canonicalName}]}] = attacker;`,
      `${withCanonical}\n${canonicalName}.make = attacker;`,
      `${withCanonical}\nimport { ${canonicalName} } from './fake-problem.ts';`,
      withCanonical.replace(`error: [${canonicalName}, `, `error: [${canonicalName}, ${canonicalName}, `),
      withCanonical.replace(`error: [${canonicalName}, `, 'error: [UnknownProblemSchema, '),
      withCanonical.replace('StockListInvalidProblemSchema, ', ''),
    ];
    yield* assertRejectedSources(root, contractPath, invalidSources, /module APIs require/u);
  }),
);

it('proves only closed schema and request-discriminator dispatch through the unchanged governed client', () => {
  const options = {
    apiValue: 'StockListApi',
    authorizedOperation: 'executeStockListWithAuthorization',
    clientHelper: 'stockListClient',
    contractImport: STOCK_LIST_CLIENT_CONTRACT_IMPORT,
    endpointGroup: 'stockList',
    generatedHeader: MODULE_API_HEADER,
    invocationKind: MODULE_API_KIND,
    publicOperation: 'executeStockList',
  } as const;
  const expectation = {
    ...options,
    defaultApiPrefix: INVENTORY_API_PREFIX,
    ownerApiValue: options.apiValue,
    ownerContractImport: options.contractImport,
  };
  const direct = governedClientFixture(options);
  const dispatch = 'Effect.flatMap((client) => client.stockList.execute({ payload }))';
  const schema = direct
    .replace('Effect, Redacted', SCHEMA_DISPATCH_IMPORTS)
    .replace('import { StockListApi }', 'import { StockListApi, StockListRequestSchema }')
    .replace(
      dispatch,
      `Effect.flatMap((client) => {
      if (Schema.is(StockListRequestSchema.members[1])(payload)) { return client.stockList.execute({ payload }); }
      return client.stockList.execute({ payload });
    })`,
    );
  const projection = direct.replace(
    dispatch,
    `Effect.flatMap((client) => {
    if (payload.operation === 'RECOVER') { return client.stockList.execute({ payload: { operation: payload.operation, requestRef: payload.requestRef } }); }
    return payload.operation === 'LOAD' ? client.stockList.execute({ payload: { operation: payload.operation } }) : client.stockList.execute({ payload });
  })`,
  );
  const switched = direct.replace(
    dispatch,
    `Effect.flatMap((client) => {
    switch (payload.operation) {
      case 'LOAD': return client.stockList.execute({ payload: { operation: payload.operation } });
      case 'RECOVER': return client.stockList.execute({ payload });
    }
  })`,
  );
  const bracedSwitch = switched.replace(
    "case 'LOAD': return client.stockList.execute({ payload: { operation: payload.operation } });",
    "case 'LOAD': { return client.stockList.execute({ payload: { operation: payload.operation } }); }",
  );
  expect(hasGeneratedGovernedClientContract(bracedSwitch, expectation)).toBe(true);
  for (const unsafeBraced of [
    bracedSwitch.replace('{ return client.stockList', '{ untrusted(); return client.stockList'),
    bracedSwitch.replace('{ return client.stockList', '{ { return client.stockList').replace('}); }', '}); } }'),
    bracedSwitch.replace(
      "case 'LOAD': { return client.stockList.execute({ payload: { operation: payload.operation } }); }",
      "case 'LOAD': { break; }",
    ),
  ]) {
    expect(hasGeneratedGovernedClientContract(unsafeBraced, expectation)).toBe(false);
  }
  const modeDispatch = direct.replace(
    dispatch,
    `Effect.flatMap((client) => payload.mode === 'REVALIDATION'
    ? client.stockList.execute({ payload: { mode: payload.mode, binding: payload.binding } })
    : client.stockList.execute({ payload }))`,
  );
  expect(hasGeneratedGovernedClientContract(modeDispatch, expectation)).toBe(true);
  expect(
    hasGeneratedGovernedClientContract(modeDispatch.replace('payload.mode ===', 'payload.untrusted ==='), expectation),
  ).toBe(false);
  const membership = direct.replace(
    dispatch,
    `Effect.flatMap((client) => 'requestRef' in payload
    ? client.stockList.execute({ payload })
    : client.stockList.execute({ payload }))`,
  );
  expect(hasGeneratedGovernedClientContract(membership, expectation)).toBe(true);
  const membershipGuard = "'requestRef' in payload";
  for (const unsafeMembership of [
    membership.replace(membershipGuard, "'requestRef' in other"),
    membership.replace(membershipGuard, 'untrustedKey in payload'),
    membership.replace(membershipGuard, "'requestRef' in payload.nested"),
    membership.replace(
      'client.stockList.execute({ payload })\n    : client.stockList.execute({ payload })',
      'client.other.execute({ payload })\n    : client.stockList.execute({ payload })',
    ),
  ]) {
    expect(hasGeneratedGovernedClientContract(unsafeMembership, expectation)).toBe(false);
  }
  for (const variant of [schema, projection, switched]) {
    expect(hasGeneratedGovernedClientContract(variant, expectation)).toBe(true);
  }
  const unsafe = [
    schema.replace('Schema.is(StockListRequestSchema.members[1])(payload)', 'Math.random()'),
    schema.replace(
      'Schema.is(StockListRequestSchema.members[1])(payload)',
      'FakeSchema.is(StockListRequestSchema.members[1])(payload)',
    ),
    schema.replace(SCHEMA_DISPATCH_IMPORTS, 'Effect, Redacted, Schema, Layer'),
    schema.replace(SCHEMA_DISPATCH_IMPORTS, 'Effect, Redacted, Schema as FakeSchema'),
    schema.replace("from '../../shared/apis/stock-list.ts'", "from '../../private/stock-list.ts'"),
    schema.replace('client.stockList.execute({ payload });', 'client.other.execute({ payload });'),
    schema.replace('client.stockList.execute({ payload });', 'Effect.succeed(payload);'),
    schema.replace(AUTHORIZATION_VALUE, AUTHORIZATION_VALUE_TAIL),
    schema.replace(DEFAULT_API_PREFIX, DEFAULT_API_PREFIX_TAIL),
    projection.replace('requestRef: payload.requestRef', 'requestRef: payload.otherRef'),
    switched.replace(
      "case 'LOAD': return client.stockList.execute({ payload: { operation: payload.operation } });",
      "case 'LOAD': break;",
    ),
  ];
  for (const variant of unsafe) {
    expect(hasGeneratedGovernedClientContract(variant, expectation)).toBe(false);
  }
});

it('proves inferred native scoped factories and nested callback type parameters without accepting forged ownership', () => {
  const owner = INVENTORY_OWNER_PATH;
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

it('recognizes native Effect.fn scoped generators only with the actual Core factory ABI', () => {
  const owner = INVENTORY_OWNER_PATH;
  const file = `${owner}/src/api/stock-list.read.ts`;
  const service = `${owner}/src/services/stock-list.ts`;
  const source = `import type { ScopedTransactionExecutor, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
export const factory = Effect.fn('factory')(function* services(transaction: ScopedTransactionExecutor, scope: OperationalScope, compositionRevision: string | undefined) { return { read: () => Effect.succeed(scope.tenantId) }; });`;
  const accepts = (candidate: string) =>
    hasOwnerLocalReadServiceFactory(
      new Map([
        [file, "import { factory } from '../services/stock-list.ts';"],
        [service, candidate],
      ]),
      file,
      owner,
      'factory',
    );
  expect(accepts(source)).toBe(true);
  for (const invalid of [
    source.replace('compositionRevision: string | undefined', 'compositionRevision: string'),
    source.replace('scope: OperationalScope', 'scope: unknown'),
    source.replace('transaction: ScopedTransactionExecutor', 'transaction: unknown'),
    source.replace("from 'effect'", "from './fake-effect.ts'"),
    source.replace(CORE_RUNTIME_SOURCE_IMPORT, FAKE_CORE_SOURCE_IMPORT),
    source.replace('function* services', 'async function* services'),
    source.replace(
      'compositionRevision: string | undefined',
      'compositionRevision: string | undefined, injected: unknown',
    ),
  ]) {
    expect(accepts(invalid)).toBe(false);
  }
});

it('binds native handler audiences to the actual owner and preserves thin server options', () => {
  const source = governedServerFixture({
    apiValue: 'StockListApi',
    contractImport: STOCK_LIST_SERVER_CONTRACT_IMPORT,
    exportedName: 'stockListReadApiLive',
    generatedHeader: MODULE_API_HEADER,
    group: 'stockList',
    readValue: 'stockListRead',
  });
  const api =
    "export const api = HttpApi.make('InventoryApi') // <generated-governed-http-api-additions>\n// </generated-governed-http-api-additions>\n.annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' }).pipe(identity);";
  const withAudience = source.replace(
    AUTHENTICATE_PRINCIPAL_BINDING,
    `${AUTHENTICATE_PRINCIPAL_BINDING}, audience: 'inventory-stock'`,
  );
  expect(hasGeneratedGovernedServerContract(withAudience, 'stockListReadApiLive', api, INVENTORY_DEPLOYMENT_ID)).toBe(
    true,
  );
  for (const invalid of [
    withAudience.replace(INVENTORY_AUDIENCE_OPTION, "audience: 'other'"),
    withAudience.replace(INVENTORY_AUDIENCE_OPTION, 'audience: configuredAudience'),
    withAudience.replace(INVENTORY_AUDIENCE_OPTION, "audience: 'inventory-stock', unknown: unsafe"),
    withAudience.replace(AUTHENTICATE_PRINCIPAL_BINDING, 'authenticatePrincipal: bypass'),
  ]) {
    expect(hasGeneratedGovernedServerContract(invalid, 'stockListReadApiLive', api, INVENTORY_DEPLOYMENT_ID)).toBe(
      false,
    );
  }
});

it('resolves the published owner client once and requires exact relative Action exports', () => {
  const owner = INVENTORY_OWNER_PATH;
  const file = `${owner}/shared/inventory-stock-client.ts`;
  const publication =
    "// <generated-action-http-client-exports>\nexport * from '../src/api/reserve-action-client.ts';\n// </generated-action-http-client-exports>";
  const sources = new Map([
    [`${owner}/package.json`, JSON.stringify({ exports: { './api/client': './shared/inventory-stock-client.ts' } })],
    [file, publication],
  ]);
  expect(ownerActionClientPublication(sources, owner, INVENTORY_DEPLOYMENT_ID)).toEqual({ file, source: publication });
  expect(hasGeneratedActionClientPublication(publication, 'reserve', RESERVE_CLIENT_RELATIVE_IMPORT)).toBe(true);
  for (const target of ['../private/reserve-action-client.ts', '../src/api/other-action-client.ts']) {
    expect(
      hasGeneratedActionClientPublication(
        publication.replace(RESERVE_CLIENT_RELATIVE_IMPORT, target),
        'reserve',
        RESERVE_CLIENT_RELATIVE_IMPORT,
      ),
    ).toBe(false);
  }
  for (const exports of [
    { './api/client': '../outside.ts' },
    { './api/client': './shared/missing.ts' },
    { './api/private-client': './shared/inventory-stock-client.ts' },
  ]) {
    sources.set(`${owner}/package.json`, JSON.stringify({ exports }));
    expect(ownerActionClientPublication(sources, owner, INVENTORY_DEPLOYMENT_ID)).toBeUndefined();
  }
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

it.live(
  'resolves an exact published contract shim with its unchanged owner-native client and rejects provenance or executable escapes',
  () =>
    Effect.gen(function* publishedContractWithOwnerClient() {
      const root = yield* makeFixture();
      yield* writeGovernedModuleApi(root);
      const contractFile = `${INVENTORY_OWNER_PATH}/shared/apis/stock-list.ts`;
      const published = STOCK_LIST_PUBLISHED_SOURCE;
      const packageFile = 'packages/inventory-public-contracts/package.json';
      const contract = yield* Effect.promise(() => readFile(path.join(root, contractFile), 'utf-8'));
      const metadata = {
        exports: { './stock-list': './src/stock-list.ts' },
        name: '@app/inventory-public-contracts',
        ontosContractOwner: {
          appId: INVENTORY_DEPLOYMENT_ID,
          moduleApis: [STOCK_LIST_STEM],
          moduleId: INVENTORY_MODULE_ID,
          packageName: INVENTORY_PACKAGE_SPECIFIER,
        },
      };
      const shim = `${MODULE_API_HEADER}// An ordinary ownership comment does not carry executable capabilities.\nexport * from '@app/inventory-public-contracts/stock-list';\n`;
      yield* write(root, published, contract);
      yield* write(root, packageFile, JSON.stringify(metadata));
      yield* write(root, contractFile, shim);
      yield* checkModuleEntrypointBoundaries(root);
      for (const invalid of [
        `${shim}export const mutable = true;`,
        shim.replace('export *', 'export let capability; export *'),
        shim.replace('export *', "import { runtime } from './private.ts'; export *"),
        shim.replace('@app/inventory-public-contracts/stock-list', '@app/private-implementation/stock-list'),
        shim.replace(
          '// An ordinary ownership comment does not carry executable capabilities.',
          '// @ontos-public-contract @app/other/stock-list',
        ),
      ]) {
        yield* write(root, contractFile, invalid);
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        expect(Exit.isFailure(result)).toBe(true);
      }
      yield* write(root, contractFile, shim);
      for (const invalid of [
        { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, moduleId: 'other.owner' } },
        { ...metadata, exports: { './stock-list': '../outside.ts' } },
        { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, moduleApis: [] } },
      ]) {
        yield* write(root, packageFile, JSON.stringify(invalid));
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        expect(Exit.isFailure(result)).toBe(true);
      }
    }),
);

it('classifies only exact published native contract shims with a proved read or Action HTTP target category', () => {
  const owner = INVENTORY_OWNER_PATH;
  const packageFile = 'packages/inventory-public-contracts/package.json';
  const readContractFile = `${owner}/shared/apis/stock-list.ts`;
  const actionFile = `${owner}/shared/apis/reserve-action.ts`;
  const readShim = "export * from '@app/inventory-public-contracts/stock-list';";
  const actionShim = "export * from '@app/inventory-public-contracts/reserve-action';";
  const actionTarget = `// @generated by OntOS Codesmith Action HTTP v1
// @ontos-action-http-owner inventory.stock
// @ontos-action-http-slug reserve
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
export const ReserveActionApi = HttpApi.make('ReserveActionApi').add(HttpApiGroup.make('reserveAction').add(HttpApiEndpoint.post('execute', '/inventory-stock/actions/reserve', { error: [], payload: PayloadSchema, success: ResultSchema })));`;
  const readTarget = moduleContractFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
  const metadata = {
    exports: { './reserve-action': './src/reserve-action.ts', './stock-list': './src/stock-list.ts' },
    name: '@app/inventory-public-contracts',
    ontosContractOwner: {
      appId: INVENTORY_DEPLOYMENT_ID,
      moduleApis: [STOCK_LIST_STEM],
      moduleId: INVENTORY_MODULE_ID,
      packageName: INVENTORY_PACKAGE_SPECIFIER,
    },
  };
  const sources = new Map([
    [`${owner}/package.json`, JSON.stringify({ name: INVENTORY_PACKAGE_SPECIFIER })],
    [
      `${owner}/vertical.manifest.ts`,
      '// @ontos-module-id inventory.stock\n// @ontos-deployment-app-id inventory-stock\n',
    ],
    [`${owner}/vertical.registration.ts`, 'export const registration = {};'],
    [`${owner}/api/index.ts`, 'export const handlers = {};'],
    [`${owner}/shared/api.ts`, 'export const api = {};'],
    [packageFile, JSON.stringify(metadata)],
    [STOCK_LIST_PUBLISHED_SOURCE, readTarget],
    [RESERVE_PUBLISHED_SOURCE, actionTarget],
  ]);
  const acceptsRead = (source = readShim) => hasPublishedGeneratedContractShim(sources, readContractFile, source);
  const acceptsAction = (source = actionShim) => hasPublishedGeneratedContractShim(sources, actionFile, source);
  expect(acceptsRead()).toBe(true);
  expect(acceptsAction()).toBe(true);
  sources.set(STOCK_LIST_PUBLISHED_SOURCE, readTarget.replace(NATIVE_HTTP_SOURCE_IMPORT, FAKE_HTTP_SOURCE_IMPORT));
  expect(acceptsRead()).toBe(false);
  sources.set(STOCK_LIST_PUBLISHED_SOURCE, `${readTarget}\nconst HttpApiGroup = fakeGroup;`);
  expect(acceptsRead()).toBe(false);
  sources.set(STOCK_LIST_PUBLISHED_SOURCE, readTarget);
  const disconnected = `${actionTarget.replace(
    'export const ReserveActionApi =',
    UNUSED_NATIVE_API_DECLARATION,
  )}\nexport const ReserveActionApi = { unsafe: true };`;
  sources.set(RESERVE_PUBLISHED_SOURCE, disconnected);
  expect(acceptsAction()).toBe(false);
  const typedConnected = `// @generated by OntOS Codesmith Action HTTP v1
// @ontos-action-http-owner inventory.stock
// @ontos-action-http-slug reserve
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/http-api';
export class ReserveActionSchemaErrorMiddleware extends HttpApiMiddleware.Service<ReserveActionSchemaErrorMiddleware>()('inventory-stock/ReserveActionSchemaErrorMiddleware', { error: ReserveActionInvalidProblemSchema }) {}
export const reserveActionGroupDefinition = HttpApiGroup.make('reserveAction').add(HttpApiEndpoint.post('execute', '/inventory-stock/actions/reserve', { error: [], payload: PayloadSchema, success: ResultSchema })).middleware(ReserveActionSchemaErrorMiddleware);
type ReserveActionGroupContract = HttpApiGroup.HttpApiGroup<'reserveAction', HttpApiGroup.Endpoints<typeof reserveActionGroupDefinition>>;
const ReserveActionGroup: ReserveActionGroupContract = reserveActionGroupDefinition;
export const ReserveActionApi = HttpApi.make('ReserveActionApi').add(ReserveActionGroup);`;
  sources.set(RESERVE_PUBLISHED_SOURCE, typedConnected);
  expect(acceptsAction()).toBe(true);
  for (const invalid of [
    typedConnected.replace('export const reserveActionGroupDefinition', 'export let reserveActionGroupDefinition'),
    typedConnected.replace('.add(ReserveActionGroup);', '.add({ unsafe: true });'),
    `${typedConnected.replace(
      'export const ReserveActionApi =',
      UNUSED_NATIVE_API_DECLARATION,
    )}\nexport const ReserveActionApi = { unsafe: true };`,
    `${typedConnected}\nObject.assign(ReserveActionApi, { unsafe: true });`,
    typedConnected.replace('.middleware(ReserveActionSchemaErrorMiddleware)', '.pipe(replaceContract)'),
    typedConnected.replace(NATIVE_HTTP_SOURCE_IMPORT, FAKE_HTTP_SOURCE_IMPORT),
    typedConnected.replace('extends HttpApiMiddleware.Service', 'extends FakeMiddleware.Service'),
  ]) {
    sources.set(RESERVE_PUBLISHED_SOURCE, invalid);
    expect(acceptsAction()).toBe(false);
  }
  sources.set(RESERVE_PUBLISHED_SOURCE, actionTarget);

  expect(acceptsRead(actionShim)).toBe(false);
  expect(acceptsAction(readShim)).toBe(false);
  for (const invalid of [
    `${readShim} export const mutable = true;`,
    `${readShim} import { runtime } from './private.ts';`,
    `${readShim} export * from '@app/other/contracts';`,
    'export const DataSchema = Schema.Struct({});',
  ]) {
    expect(acceptsRead(invalid)).toBe(false);
  }
  for (const invalid of [
    actionTarget.replace(INVENTORY_MODULE_ID, 'other.owner'),
    actionTarget.replace('// @ontos-action-http-slug reserve', '// @ontos-action-http-slug other'),
    actionTarget.replace('/inventory-stock/actions/reserve', '/other/actions/reserve'),
    actionTarget.split('import')[0],
  ]) {
    sources.set(RESERVE_PUBLISHED_SOURCE, invalid);
    expect(acceptsAction()).toBe(false);
  }
  sources.set(RESERVE_PUBLISHED_SOURCE, actionTarget);
  for (const invalid of [
    { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, packageName: '@app/other' } },
    { ...metadata, exports: { ...metadata.exports, './stock-list': '../private.ts' } },
    { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, moduleApis: [] } },
  ]) {
    sources.set(packageFile, JSON.stringify(invalid));
    expect(acceptsRead()).toBe(false);
  }
  sources.set(packageFile, JSON.stringify(metadata));
  sources.set('packages/ambiguous/package.json', JSON.stringify(metadata));
  expect(acceptsRead()).toBe(false);
});

it.live('rejects disconnected Action API constructor decoys from the actual generated producer', () =>
  Effect.gen(function* actualActionRootConnectivity() {
    const root = path.resolve(import.meta.dirname, '../..');
    const paths = [
      'verticals/pricing/package.json',
      'verticals/pricing/vertical.manifest.ts',
      'verticals/pricing/vertical.registration.ts',
      PRICING_HANDLER_PATH,
      PRICING_SHARED_API_PATH,
      'packages/pricing-contracts/package.json',
      'packages/pricing-contracts/src/apis/manage-quotation-action.ts',
      'verticals/pricing/shared/apis/manage-quotation-action.ts',
    ];
    const entries = yield* Effect.all(
      paths.map((file) =>
        Effect.promise(() => readFile(path.join(root, file), 'utf-8')).pipe(
          Effect.map((source) => [file, source] as const),
        ),
      ),
    );
    const sources = new Map(entries);
    const target = paths[6] ?? '';
    const wrapper = paths[7] ?? '';
    const original = sources.get(target) ?? '';
    const bridge = sources.get(wrapper) ?? '';
    expect(hasPublishedGeneratedContractShim(sources, wrapper, bridge)).toBe(true);
    const decoy = original.replace('export const ManageQuotationActionApi =', UNUSED_NATIVE_API_DECLARATION);
    expect(decoy).not.toBe(original);
    sources.set(target, `${decoy}\nexport const ManageQuotationActionApi = { unsafe: true };`);
    expect(hasPublishedGeneratedContractShim(sources, wrapper, bridge)).toBe(false);
    for (const [binding, field] of [
      ['ManageQuotationActionApi', 'groups'],
      ['manageQuotationActionGroupDefinition', 'endpoints'],
    ]) {
      const capture = `queueMicrotask(() => Object.assign(${binding}, { ${field}: {} }))`;
      const inside = original.replace(
        'payload: Schema.toEncoded(ManageQuotationPayloadSchema),',
        `payload: (${capture}, Schema.toEncoded(ManageQuotationPayloadSchema)),`,
      );
      expect(inside).not.toBe(original);
      sources.set(target, inside);
      expect(hasPublishedGeneratedContractShim(sources, wrapper, bridge)).toBe(false);
      sources.set(target, `${original}\n${capture};`);
      expect(hasPublishedGeneratedContractShim(sources, wrapper, bridge)).toBe(false);
    }
  }),
);

for (const [form, source, leaf] of [
  [
    'sibling relative handler',
    "import { executePrivate } from '../../party-registry/src/handlers/private.ts';\n",
    RESOLVED_FOREIGN_HANDLER,
  ],
  [
    'foreign worker',
    "import { executePrivate } from '../../party-registry/workers/private.ts';\n",
    'verticals/party-registry/workers/private.ts',
  ],
  [
    'private registration',
    "import { executePrivate } from '../../party-registry/vertical.registration.ts';\n",
    'verticals/party-registry/vertical.registration.ts',
  ],
  [
    'relative barrel chain',
    "import { executePrivate } from '../../party-registry/shared/contracts.ts';\n",
    RESOLVED_FOREIGN_HANDLER,
  ],
  [
    'renamed contracts package through real workspace symlink',
    `import { executePrivate } from '${RENAMED_CONTRACTS_PACKAGE}/contracts';\n`,
    RESOLVED_FOREIGN_HANDLER,
  ],
  [
    'type-only private import',
    "import type { PrivateInput } from '../../party-registry/src/handlers/private.ts';\n",
    RESOLVED_FOREIGN_HANDLER,
  ],
  [
    'type-only renamed contracts reexport',
    `export type { PrivateInput } from '${RENAMED_CONTRACTS_PACKAGE}/contracts';\n`,
    RESOLVED_FOREIGN_HANDLER,
  ],
] as const) {
  it.live(`rejects resolved foreign private ownership through ${form}`, () =>
    Effect.gen(function* rejectsResolvedPrivateOrigin() {
      const root = yield* makeResolvedOwnerFixture();
      yield* write(root, RESOLVED_OWNER_CONSUMER, source);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(result), form).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = Cause.pretty(result.cause);
        expect(failure).toMatch(/foreign private|cross-vertical private/u);
        expect(failure).toContain(RESOLVED_OWNER_CONSUMER);
        expect(failure).toContain(leaf);
      }
    }),
  );
}

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

for (const [name, source, contamination, allowed] of [
  [
    'selected schema value only',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\n",
    '',
    true,
  ],
  [
    'selected schema and derived type',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\nimport type { InventoryBackendConfiguration } from '@app/inventory/backend-configuration';\n",
    '',
    true,
  ],
  [
    'private dispatch from same specifier',
    "import { dispatchReservationAuthority } from '@app/inventory/backend-configuration';\n",
    '',
    false,
  ],
  [
    'private dispatch with discarded native hash',
    "import { dispatchWithDiscardedHash } from '@app/inventory/backend-configuration';\n",
    `\nimport { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
export const dispatchWithDiscardedHash = (configuration: InventoryBackendConfiguration) => {
  sha256(utf8ToBytes('discarded'));
  return dispatchReservationAuthority(configuration);
};\n`,
    false,
  ],
  [
    'private dispatch with discarded native codec',
    "import { dispatchWithDiscardedCodec } from '@app/inventory/backend-configuration';\n",
    `\nexport const dispatchWithDiscardedCodec = (configuration: InventoryBackendConfiguration) => {
  Schema.decodeUnknownEffect(InventoryBackendConfigurationSchema)(configuration);
  return dispatchReservationAuthority(configuration);
};\n`,
    false,
  ],
  [
    'private function type from same specifier',
    "import type { PrivateDispatch } from '@app/inventory/backend-configuration';\n",
    '\nexport type PrivateDispatch = typeof dispatchReservationAuthority;\n',
    false,
  ],
  [
    'eager private initializer beside selected schema',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\n",
    '\nexport const eagerPrivate = dispatchReservationAuthority({} as never);\n',
    false,
  ],
] as const) {
  it.live(`checks Inventory backend contract ${name}`, () =>
    Effect.gen(function* selectedInventoryContract() {
      const root = yield* makeSelectedInventoryFixture();
      yield* write(root, INVENTORY_SCHEMA_CONSUMER, source);
      if (contamination !== '') {
        const original = yield* Effect.promise(() => readFile(path.join(root, INVENTORY_BACKEND_CONTRACT), 'utf-8'));
        yield* write(root, INVENTORY_BACKEND_CONTRACT, `${original}${contamination}`);
      }
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : name).toBe(allowed);
      if (!allowed && Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(FOREIGN_PRIVATE_DIAGNOSTIC);
      }
    }),
  );
}

it.live('preserves the actual public portal-auth schemas and approved typed verification client', () =>
  Effect.gen(function* actualPortalPublicRoles() {
    const root = yield* makePortalPublicRoleFixture();
    yield* checkModuleEntrypointBoundaries(root);
  }),
);

for (const [name, file, contamination, selection] of [
  [
    'schema executable export',
    PORTAL_PUBLIC_SCHEMA,
    '\nexport { privateHandler } from "../src/handlers/private-contract.ts";\n',
    'privateHandler',
  ],
  [
    'schema private database dependency',
    PORTAL_PUBLIC_SCHEMA,
    "\nimport { privateTable } from '../src/database/private.ts';\n",
    undefined,
  ],
  ['schema opaque global data', PORTAL_PUBLIC_SCHEMA, '\nexport const privateGlobal = globalThis;\n', 'privateGlobal'],
  [
    'schema wrapped runtime global',
    PORTAL_PUBLIC_SCHEMA,
    '\nexport const privateGlobal = globalThis as unknown;\n',
    'privateGlobal',
  ],
  ['schema mutable declaration', PORTAL_PUBLIC_SCHEMA, '\nexport let mutableContract = true;\n', 'mutableContract'],
  [
    'client private database dependency',
    PORTAL_PUBLIC_CLIENT,
    "\nimport { privateTable } from '../../database/private.ts';\n",
    undefined,
  ],
] as const) {
  it.live(`rejects public portal-auth ${name} contamination`, () =>
    Effect.gen(function* contaminatedPortalPublicRole() {
      const root = yield* makePortalPublicRoleFixture();
      yield* write(
        root,
        'verticals/commerce-customer-context/src/database/private.ts',
        'export const privateTable = {};\n',
      );
      yield* write(root, CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH, 'export const privateHandler = () => true;\n');
      const original = yield* Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
      yield* write(root, file, `${original}${contamination}`);
      if (selection !== undefined) {
        // A real private reexport loads implementation even before its binding is selected.
        if (!contamination.includes('private-contract.ts')) {
          yield* checkModuleEntrypointBoundaries(root);
        }
        const consumer = yield* Effect.promise(() => readFile(path.join(root, PORTAL_SHELL_CONSUMER), 'utf-8'));
        yield* write(
          root,
          PORTAL_SHELL_CONSUMER,
          `${consumer}import { ${selection} } from '@app/commerce-customer-context/portal-auth/contracts';\n`,
        );
      }
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(result), name).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(FOREIGN_PRIVATE_DIAGNOSTIC);
      }
    }),
  );
}

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

it.live('publishes actual source-selector schemas and proved wire codecs without unproved routines', () =>
  Effect.gen(function* actualDormantEffectSchemaContract() {
    const root = yield* makeFixture();
    const workspace = path.resolve(import.meta.dirname, '../..');
    const source = yield* Effect.promise(() =>
      readFile(path.join(workspace, 'verticals/symmy-integration/shared/domain/symmy-source-selector.ts'), 'utf-8'),
    );
    const target = `${INVENTORY_VERTICAL_PATH}/shared/domain/source-selector.ts`;
    const specifier = `${INVENTORY_PACKAGE_SPECIFIER}/source-selector`;
    yield* write(root, WORKSPACE_MANIFEST_PATH, VERTICALS_WORKSPACE_DECLARATION);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/package.json`,
      JSON.stringify({
        exports: { './source-selector': './shared/domain/source-selector.ts' },
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
    for (const [name, value, binding, allowed] of [
      ['native dormant callable', source, 'SymmyEncodedSourceCodeSchema, SymmySelectedSourceCodeSchema', true],
      [
        'erased codec error and result types',
        source,
        'type SymmySourceSelectorError, type SymmyDecodedSourceSelector',
        true,
      ],
      ['unapproved runtime class', source, 'SymmySourceSelectorError', false],

      ['published wire encoder', source, 'encodeSymmySourceSelector', true],
      ['published wire decoder', source, 'decodeSymmySourceSelector', true],
      ['published wire verifier', source, 'verifySymmySourceSelector', true],
      [
        'published wire codecs',
        source,
        'encodeSymmySourceSelector, decodeSymmySourceSelector, verifySymmySourceSelector',
        true,
      ],
      [
        'unproved business callable',
        `${source}\nexport const dispatchPrivateBusinessOperation = () => globalThis;`,
        'dispatchPrivateBusinessOperation',
        false,
      ],
      [
        'contextual ambient initializer',
        `${source}\nconst capturedAmbient = process.env.VALUE;`,
        'encodeSymmySourceSelector',
        false,
      ],
      [
        'contextual eager schema field getter',
        `${source}\nconst UnusedSchema = Schema.Struct({ get field() { return fetch('remote'); } });`,
        'encodeSymmySourceSelector',
        false,
      ],
      [
        'contextual native hash mutation',
        `${source}\nconst capturedHash = sha256; export const mutateHash = () => { capturedHash.create = foreignHash; };`,
        'encodeSymmySourceSelector',
        false,
      ],
      ['executed callable', `${source}\ndecodeSymmySourceSelector('code');`, 'SymmySelectedSourceCodeSchema', false],
      [
        'dynamic trace',
        source.replace("Effect.fn('SymmySourceSelector.decode')", 'Effect.fn(deriveTrace())'),
        'SymmySelectedSourceCodeSchema',
        false,
      ],
      [
        'foreign factory',
        `import { Effect as ForeignEffect } from './foreign-effect.ts';\n${source.replace("Effect.fn('SymmySourceSelector.decode')", "ForeignEffect.fn('SymmySourceSelector.decode')")}`,
        'SymmySelectedSourceCodeSchema',
        false,
      ],
      ['mutated native factory', `${source}\nEffect.fn = replacement;`, 'SymmySelectedSourceCodeSchema', false],
    ] as const) {
      yield* write(root, target, value);
      yield* write(
        root,
        'apps/shell-super-app/src/source-selector-consumer.ts',
        `import { ${binding} } from '${specifier}';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? `${name}: ${Cause.pretty(result.cause)}` : name).toBe(
        allowed,
      );
    }
  }),
);

it.live('keeps genuine generated API publication distinct from a private callable in the same export', () =>
  Effect.gen(function* selectedGeneratedApiPublication() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    yield* write(root, WORKSPACE_MANIFEST_PATH, VERTICALS_WORKSPACE_DECLARATION);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/package.json`,
      JSON.stringify({
        exports: {
          './api': './shared/api.ts',
          './api/stock-list': './shared/apis/stock-list.ts',
          './facade-codec': './shared/domain/facade-codec.ts',
          './schema-facade': './shared/domain/schema-facade.ts',
        },
        modernjs: {
          appId: INVENTORY_DEPLOYMENT_ID,
          ontosModule: { manifest: './vertical.manifest.ts', moduleId: INVENTORY_MODULE_ID },
        },
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
    for (const file of [SHARED_CONTRACTS_PACKAGE_JSON_PATH, SHARED_PROBLEM_DETAILS_SOURCE_PATH]) {
      yield* write(
        root,
        file,
        yield* Effect.promise(() => readFile(path.resolve(import.meta.dirname, '../..', file), 'utf-8')),
      );
    }
    yield* Effect.promise(() => mkdir(path.join(root, APP_PACKAGE_LINK_DIRECTORY), { recursive: true }));
    for (const [name, target] of [
      ['inventory-stock', INVENTORY_VERTICAL_PATH],
      [SHARED_CONTRACTS_WORKSPACE_NAME, SHARED_CONTRACTS_WORKSPACE_PATH],
    ] as const) {
      yield* Effect.promise(() =>
        symlink(path.join(root, target), path.join(root, APP_PACKAGE_LINK_DIRECTORY, name), 'dir'),
      );
    }
    const contractFile = `${INVENTORY_VERTICAL_PATH}/shared/apis/stock-list.ts`;
    const original = yield* Effect.promise(() => readFile(path.join(root, contractFile), 'utf-8'));
    const contract = `${original.replace(
      'export const StockListApi =',
      "import { Schema } from 'effect';\nexport const StockListRequestSchema = Schema.Struct({});\nexport const StockListResponseSchema = Schema.Struct({});\nexport const StockListApi =",
    )}\nexport const privateCallable = () => true;\nexport { StockPolicyProblemSchema } from '../domain/stock-policy.ts';\n`;
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/shared/domain/stock-policy.ts`,
      `import { Schema } from 'effect';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
export class StockRejected extends Schema.TaggedError<StockRejected>()('StockRejected', { reason: Schema.Literal('rejected') }) {}
export const StockPolicyProblemSchema = makeProblemDetailsSchema('StockPolicyProblem', 422, { reason: StockRejected.fields.reason });
export const dormantPrivateHandler = () => true;
`,
    );
    expect(hasGeneratedModuleApiContract(contract, 'StockListApi', 'stockList', 'stock-list')).toBe(true);
    yield* write(root, contractFile, contract);
    // Same shape as the actual Symmy receiver: public immutable data reused by its enrolled defineRead.
    const accessName = 'stockListAccessDeclaration';
    const accessDeclaration = `export const ${accessName} = {
      key: 'inventory.stock.stock-list.read', kind: 'read', modes: ['run'],
      placement: { group: 'stock-list', level: 'basic' }, risk: 'sensitive', selectors: [],
    } as const;`;
    const partyMetadataSource = yield* Effect.promise(() =>
      readFile(
        path.resolve(import.meta.dirname, '../..', 'verticals/party-registry/shared/apis/organization-record-facts.ts'),
        'utf-8',
      ),
    );
    const versionMetadata = partyMetadataSource.slice(
      partyMetadataSource.indexOf('export const OrganizationBusinessSourceProjectionVersion'),
      partyMetadataSource.indexOf('export const OrganizationBusinessSourceStatement'),
    );
    const tupleMetadata = partyMetadataSource.slice(
      partyMetadataSource.indexOf('const currentFields'),
      partyMetadataSource.indexOf('export const OrganizationBusinessCorrectionFields'),
    );
    const currentFieldsSpread = '...currentFields';
    expect(versionMetadata).toContain('as const');
    expect(tupleMetadata).toContain(currentFieldsSpread);
    const withDeclaration = `${contract}\n${versionMetadata}\n${tupleMetadata}\n${accessDeclaration}\nexport const detachedAccessDeclaration = {
      key: 'inventory.stock.other.read', kind: 'read', modes: ['run'],
      placement: { group: 'stock-list', level: 'basic' }, risk: 'sensitive', selectors: [],
    } as const;\n`;
    const readFileName = `${INVENTORY_VERTICAL_PATH}/src/api/stock-list.read.ts`;
    const originalRead = yield* Effect.promise(() => readFile(path.join(root, readFileName), 'utf-8'));
    const withReceiver = originalRead.replace(
      /accessDeclaration: \{[^}]+placement: \{[^}]+\}[^}]+\}/u,
      `accessDeclaration: ${accessName}`,
    );
    expect(withReceiver).not.toBe(originalRead);
    const receiver = `import { ${accessName} } from '../../shared/apis/stock-list.ts';\n${withReceiver}`;
    yield* write(root, contractFile, withDeclaration);
    yield* write(root, readFileName, receiver);
    const consumer = 'apps/shell-super-app/src/generated-api-consumer.ts';
    yield* write(root, consumer, `import { StockListApi } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`);
    yield* checkModuleEntrypointBoundaries(root);
    const facadeFile = `${INVENTORY_VERTICAL_PATH}/shared/api.ts`;
    const originalFacade = yield* Effect.promise(() => readFile(path.join(root, facadeFile), 'utf-8'));
    const facade = `import { createMicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';\n${originalFacade}\nexport { StockListRequestSchema } from './apis/stock-list.ts';
export const operationContexts = { readiness: createMicroVerticalOperationContext({ method: 'GET', operationId: 'InventoryApi:inventory-stock:readiness', routePath: '/inventory-stock/readiness' }) };`;
    yield* write(root, facadeFile, facade);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/shared/domain/facade-codec.ts`,
      `import { Effect, Schema } from 'effect';
import { StockListRequestSchema } from '${INVENTORY_PACKAGE_SPECIFIER}/api';
export const decodeFacadeRequest = (input: Schema.Json) => Schema.decodeUnknownEffect(StockListRequestSchema, { onExcessProperty: 'error' })(input).pipe(Effect.map((decoded) => ({ normalized: decoded })));`,
    );
    yield* write(
      root,
      consumer,
      `import { decodeFacadeRequest } from '${INVENTORY_PACKAGE_SPECIFIER}/facade-codec';\n`,
    );
    yield* checkModuleEntrypointBoundaries(root);
    for (const alteredFacade of [
      facade.replace('@modern-js/bff-effect/microvertical-api', '@foreign/bff-effect/microvertical-api'),
      facade.replace('.addHttpApi(StockListApi)', '.addHttpApi(UnclaimedApi)'),
      `${facade}\napi.authority = acquireAuthority();`,
    ]) {
      yield* write(root, facadeFile, alteredFacade);
      expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root))), alteredFacade).toBe(true);
    }
    yield* write(root, facadeFile, originalFacade);
    const schemaFacadeFile = `${INVENTORY_VERTICAL_PATH}/shared/domain/schema-facade.ts`;
    const schemaFacade = `import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
export { FacadeRequestSchema as StockListRequestSchema } from './pure-schema-leaf.ts';
export const FacadeProblemSchema = makeProblemDetailsSchema('FacadeProblem', 400, {});`;
    yield* write(root, schemaFacadeFile, schemaFacade);
    const pureLeafFile = `${INVENTORY_VERTICAL_PATH}/shared/domain/pure-schema-leaf.ts`;
    const pureLeaf = `import { Schema } from 'effect';
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
export const FacadeRequestSchema = Schema.Struct({ code: Schema.String.check(Schema.makeFilter((code) => supportedCurrencies.has(code) ? undefined : 'Unknown currency')) });`;
    yield* write(root, pureLeafFile, pureLeaf);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/shared/domain/facade-codec.ts`,
      `import { Effect, Schema } from 'effect';
import { StockListRequestSchema } from '${INVENTORY_PACKAGE_SPECIFIER}/schema-facade';
export const decodeFacadeRequest = (input: Schema.Json) => Schema.decodeUnknownEffect(StockListRequestSchema, { onExcessProperty: 'error' })(input).pipe(Effect.map((decoded) => ({ normalized: decoded })));`,
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* write(root, pureLeafFile, `${pureLeaf}\nconst ambientLeaf = process.env.VALUE;`);
    expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
    yield* write(root, pureLeafFile, pureLeaf);
    for (const alteredSchemaFacade of [
      schemaFacade.replace('@app/shared-contracts/problem-details', '@foreign/problem-details'),
      `${schemaFacade}\nacquireAuthority();`,
    ]) {
      yield* write(root, schemaFacadeFile, alteredSchemaFacade);
      expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root))), alteredSchemaFacade).toBe(true);
    }
    yield* Effect.promise(() => rm(path.join(root, schemaFacadeFile)));
    yield* Effect.promise(() => rm(path.join(root, pureLeafFile)));
    yield* Effect.promise(() => rm(path.join(root, `${INVENTORY_VERTICAL_PATH}/shared/domain/facade-codec.ts`)));
    yield* write(root, contractFile, withDeclaration);
    const annotated = `${withDeclaration}\nexport const AnnotatedRequestSchema = StockListRequestSchema.annotate({ parseOptions: { onExcessProperty: 'error' } });`;
    yield* write(root, contractFile, annotated);
    yield* write(
      root,
      consumer,
      `import { AnnotatedRequestSchema } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`,
    );
    yield* checkModuleEntrypointBoundaries(root);
    const unsafeAnnotation = annotated.replace(
      "parseOptions: { onExcessProperty: 'error' }",
      'get parseOptions() { return acquireAuthority(); }',
    );
    yield* write(root, contractFile, unsafeAnnotation);
    expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
    yield* write(
      root,
      consumer,
      `import { OrganizationBusinessUpdateFields } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`,
    );
    expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
    for (const unsafe of [
      `${withDeclaration}\nexport const AnnotatedRequestSchema = Schema.String['annotate']({ message: () => globalThis });`,
      `${withDeclaration}\nconst annotateSchema = Schema.String.annotate; export const AnnotatedRequestSchema = annotateSchema({ message: () => globalThis });`,
      `${withDeclaration}\nconst makeAnnotatedSchema = () => Schema.String.annotate({ message: () => globalThis }).annotate({ identifier: 'safe' }); export const AnnotatedRequestSchema = makeAnnotatedSchema();`,
    ]) {
      yield* write(root, contractFile, unsafe);
      yield* write(
        root,
        consumer,
        `import { AnnotatedRequestSchema } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`,
      );
      expect(Exit.isFailure(yield* Effect.exit(checkModuleEntrypointBoundaries(root)))).toBe(true);
    }
    yield* write(root, contractFile, withDeclaration);

    yield* write(root, consumer, `import { ${accessName} } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`);
    yield* checkModuleEntrypointBoundaries(root);
    const updateFieldsName = 'OrganizationBusinessUpdateFields';
    const metadataNames = 'OrganizationBusinessSourceProjectionVersion, OrganizationBusinessUpdateFields';
    yield* write(root, consumer, `import { ${metadataNames} } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`);
    yield* checkModuleEntrypointBoundaries(root);

    const repeatedSpreads = Array.from({ length: 13 }, (_, index) =>
      index === 0
        ? "const repeated0 = ['field'] as const;"
        : `const repeated${index} = [...repeated${index - 1}, ...repeated${index - 1}] as const;`,
    ).join('\n');
    const oversizedMetadata = `${withDeclaration}\n${repeatedSpreads}\nexport const repeatedMetadata = [...repeated12] as const;`;
    for (const [name, source, readSource, imported] of [
      ['detached metadata', withDeclaration, receiver, 'detachedAccessDeclaration'],
      ['bounded tuple expansion', oversizedMetadata, receiver, 'repeatedMetadata'],
      [
        'tuple call',
        withDeclaration.replace(currentFieldsSpread, '...makeForeignFields()'),
        receiver,
        updateFieldsName,
      ],
      [
        'tuple object/getter',
        withDeclaration.replace("'current.partyRef'", '({ get value() { return acquireAuthority(); } })'),
        receiver,
        updateFieldsName,
      ],
      [
        'foreign tuple spread',
        `import { foreignFields } from '@app/foreign-contract';\n${withDeclaration.replace(currentFieldsSpread, '...foreignFields')}`,
        receiver,
        updateFieldsName,
      ],
      [
        'unknown tuple spread',
        withDeclaration.replace(currentFieldsSpread, '...unknownFields'),
        receiver,
        updateFieldsName,
      ],
      [
        'mutable tuple source',
        withDeclaration.replace('const currentFields =', 'let currentFields ='),
        receiver,
        updateFieldsName,
      ],
      [
        'tuple alias mutation',
        `${withDeclaration}\nconst alias = OrganizationBusinessUpdateFields; export const mutate = () => alias.push('extra');`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple wrapped alias mutation',
        `${withDeclaration}\nconst alias = { fields: OrganizationBusinessUpdateFields } as const; export const mutate = () => alias.fields.push('extra');`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple dependency mutation',
        `${withDeclaration}\nexport const mutate = () => currentFields.push('extra');`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple escape',
        `${withDeclaration}\nexport const leak = () => consume(OrganizationBusinessUpdateFields);`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple stored globally',
        `${withDeclaration}\nexport const leak = () => { globalThis.fields = OrganizationBusinessUpdateFields; };`,
        receiver,
        updateFieldsName,
      ],

      [
        'tuple stored in class',
        `${withDeclaration}\nexport class TupleStore { static value = OrganizationBusinessUpdateFields; } export const mutate = () => Reflect.set(TupleStore.value, 0, 'forged');`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple tagged template escape',
        `${withDeclaration}\nfunction corrupt(_strings: TemplateStringsArray, value: unknown) { (value as unknown[])[0] = globalThis; } corrupt\`\${OrganizationBusinessUpdateFields}\`;`,
        receiver,
        updateFieldsName,
      ],
      [
        'eager unknown tagged template',
        `${withDeclaration}\nfunction corrupt(_strings: TemplateStringsArray) { return globalThis; } corrupt\`opaque\`;`,
        receiver,
        updateFieldsName,
      ],
      [
        'tuple constructor escape',
        `${withDeclaration}\nexport const leak = () => new ForeignBox(OrganizationBusinessUpdateFields);`,
        receiver,
        updateFieldsName,
      ],
      [
        'unknown field',
        withDeclaration.replace('selectors: [],', 'selectors: [], authority: true,'),
        receiver,
        accessName,
      ],
      ['nonliteral field', withDeclaration.replace("risk: 'sensitive'", 'risk: chooseRisk()'), receiver, accessName],
      ['mutation', `${withDeclaration}\n${accessName}.risk = 'routine';`, receiver, accessName],
      ['escaped metadata', `${withDeclaration}\nconsume(${accessName});`, receiver, accessName],
      [
        'foreign constructor',
        withDeclaration,
        receiver.replace(CORE_RUNTIME_SOURCE_IMPORT, FAKE_CORE_SOURCE_IMPORT),
        accessName,
      ],
      [
        'quoted duplicate receiver key',
        withDeclaration,
        receiver.replace(
          `accessDeclaration: ${accessName}`,
          `accessDeclaration: ${accessName}, 'accessDeclaration': detachedAccessDeclaration`,
        ),
        accessName,
      ],
      [
        'spread overrides receiver key',
        withDeclaration,
        receiver.replace(`accessDeclaration: ${accessName}`, `accessDeclaration: ${accessName}, ...otherDescriptor`),
        accessName,
      ],
      [
        'computed receiver key',
        withDeclaration,
        receiver.replace(
          `accessDeclaration: ${accessName}`,
          `accessDeclaration: ${accessName}, [otherKey]: detachedAccessDeclaration`,
        ),
        accessName,
      ],
      ['disconnected read metadata', withDeclaration, originalRead, accessName],
    ] as const) {
      yield* write(root, contractFile, source);
      yield* write(root, readFileName, readSource);
      yield* write(root, consumer, `import { ${imported} } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`);
      const invalid = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(invalid), name).toBe(true);
    }
    yield* write(root, contractFile, withDeclaration);
    yield* write(root, readFileName, receiver);
    yield* write(root, consumer, `import { privateCallable } from '${INVENTORY_PACKAGE_SPECIFIER}/api/stock-list';\n`);
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(FOREIGN_PRIVATE_DIAGNOSTIC);
      expect(Cause.pretty(result.cause)).toContain(contractFile);
    }
  }),
);

for (const [binding, allowed] of [
  ['RefinedPublicSchema', true],
  ['privateCallable', false],
] as const) {
  it.live(`classifies refined public schema separately from ${binding}`, () =>
    Effect.gen(function* refinedSchemaPublication() {
      const root = yield* makeResolvedOwnerFixture();
      const privateOrigin = 'verticals/party-registry/src/handlers/private-contract.ts';
      yield* write(root, privateOrigin, 'export const privateCallable = () => true;\n');
      yield* write(
        root,
        'verticals/party-registry/shared/contracts.ts',
        `import { Schema } from 'effect';
export const RefinedPublicSchema = Schema.Struct({ id: Schema.String }).check(
  Schema.makeFilter(({ id }) => id.length > 0 ? undefined : 'Expected an identifier'),
);
${allowed ? 'export const privateCallable = () => true;' : "export { privateCallable } from '../src/handlers/private-contract.ts';"}
`,
      );
      yield* write(
        root,
        RESOLVED_OWNER_CONSUMER,
        `import { ${binding} } from '${RENAMED_CONTRACTS_PACKAGE}/contracts';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(allowed);
      if (!allowed && Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(privateOrigin);
      }
    }),
  );
}

for (const [binding, subpath, allowed] of [
  ['CatalogSelectionWithQuantitySchema', CATALOG_SELECTION_CONTRACT_SUBPATH, true],
  ['CatalogSelectionSchema', CATALOG_SELECTION_CONTRACT_SUBPATH, true],
  ['CatalogResourceRefSchema', 'catalog-revision-reference', true],
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
        `import { ${binding} } from '@app/catalog/domain/${subpath}';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : binding).toBe(allowed);
    }),
  );
}
