import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit, Match } from 'effect';
import { expect, it } from 'effect-rstest';
import { validateGatewayIssuerEntrypoints } from '../check-module-entrypoint-boundaries.mts';
import { gatewayContextAuthorizationEntrypoints } from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasValidGovernedHttpCompositionRoot,
  hasOwnerLocalReadServiceFactory,
  hasOwnerLocalReadServiceFactoryResult,
  hasPublishedGeneratedContractShim,
  hasGeneratedGovernedServerContract,
} from '../generated-governed-http-boundary.mts';
import {
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
  publishedResourceRefContractExports,
  resolvePublishedContractModuleId,
} from '../published-outbox-contracts.mts';
import {
  PRIVATE_COLOCATED_CALLABLE_CASE,
  PARTY_VERTICAL_PATH,
  CUSTOMER_CONTEXT_VERTICAL_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_DEPENDENCY_VERSION,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  APP_PACKAGE_LINK_DIRECTORY,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  VERTICALS_WORKSPACE_DECLARATION,
  CATALOG_VERTICAL_PATH,
  PRICING_SHARED_API_PATH,
  PRICING_HANDLER_PATH,
  STOCK_LIST_SERVER_CONTRACT_IMPORT,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_MODULE_ID,
  STOCK_LIST_PUBLISHED_SOURCE,
  NATIVE_HTTP_SOURCE_IMPORT,
  FAKE_HTTP_SOURCE_IMPORT,
  CORE_RUNTIME_SOURCE_IMPORT,
  FAKE_CORE_SOURCE_IMPORT,
  EXPECTED_EFFECT_FAILURE,
  acceptsTypedGtinBinding,
  checkModuleEntrypointBoundaries,
  ARCHIVE_ORGANIZATION_DECLARATION,
  PAYLOAD_SCHEMA_PROPERTY,
  READ_ACCESS_SOURCE,
  AUTHENTICATE_PRINCIPAL_BINDING,
  STOCK_LIST_STEM,
  STOCK_LIST_READ_BINDING,
  STOCK_LIST_READ_FILE,
  SHARED_GATEWAY_FACTORY,
  MODULE_API_KIND,
  MODULE_API_HEADER,
  STOCK_LIST_API_BINDING,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_CLIENT_SOURCE_PATH,
  PARTY_DEPLOYMENT_ID,
  CANONICAL_MODULE_ROUTE,
  CANONICAL_MODULE_LOADER,
  CANONICAL_MODULE_CLIENT_LOADER,
  CANONICAL_LOADER_FIXTURE,
  PRIVATE_ROUTE_METADATA,
  CANONICAL_ROUTE_SOURCE,
  PARTY_OUTBOX_SPECIFIER,
  PARTY_PACKAGE_NAME,
  INVENTORY_VERTICAL_PATH,
  INVENTORY_REGISTRATION_PATH,
  write,
  governedClientFixture,
  governedServerFixture,
  moduleContractFixture,
  moduleReadFixture,
  assertRejectedSources,
  makeFixture,
  ENGAGEMENT_ACTION_FILE,
  ENGAGEMENT_REJECTION,
  writeEngagementLifecycleFixture,
  writeGovernedModuleApi,
  partyResourceSource,
  partyPackage,
  partyClientSource,
  generatedPartyDetailClientSource,
  generatedPartyCommandClientSource,
  assertPublishedPartyUsage,
  partyManifestSource,
  readPricingSourceTree,
  PROTECTED_READ_AUTHORIZATION,
  NON_PROTECTED_READ_AUTHORIZATION,
  carrierBlock,
  INVENTORY_BACKEND_CONTRACT,
  INVENTORY_SCHEMA_CONSUMER,
  makeSelectedInventoryFixture,
  makeActualCatalogSelectionFixture,
  makeActualPartyClientFixture,
  makeActualMarketClientFixture,
  CATALOG_QUANTITY_CONTRACT,
} from './module-entrypoint-boundary-fixtures.mts';

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

it('accepts an exact generated PartyRef contract import', () => {
  expect(() => assertPublishedPartyUsage()).not.toThrow();
  expect(publishedResourceRefContractExports(partyPackage)).toEqual(['./resources/party']);
});

it('rejects owner runtime imports hidden in a generated ResourceRef file', () => {
  expect(() =>
    assertPublishedPartyUsage({
      readExportSource: () =>
        `${partyResourceSource}import { repository } from '../../src/db/repository.ts';\nvoid repository;\n`,
    }),
  ).toThrow(/must remain a generated schema-only ResourceRef contract/u);
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

it('rejects an aggregate whose client leaf has no Codesmith metadata', () => {
  expect(() =>
    assertPublishedPartyUsage({
      moduleSpecifiers: [PARTY_API_CLIENT_SPECIFIER],
      readExportSource: (target) =>
        target === PARTY_CLIENT_SOURCE_PATH ? partyClientSource : 'export const executePartyDetail = true;\n',
    }),
  ).toThrow(/must remain a generated public Effect client aggregate/u);
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

it('recognizes native Effect.fn scoped generators only with the actual Core factory ABI', () => {
  const owner = INVENTORY_VERTICAL_PATH;
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

it.live(
  'resolves an exact published contract shim with its unchanged owner-native client and rejects provenance or executable escapes',
  () =>
    Effect.gen(function* publishedContractWithOwnerClient() {
      const root = yield* makeFixture();
      yield* writeGovernedModuleApi(root);
      const contractFile = `${INVENTORY_VERTICAL_PATH}/shared/apis/stock-list.ts`;
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

for (const owner of [CATALOG_VERTICAL_PATH, CUSTOMER_CONTEXT_VERTICAL_PATH]) {
  it.live(`proves the full native operationContracts array for ${owner}, independent of marker placement`, () =>
    Effect.gen(function* nativeOwnerOperationInventory() {
      const root = path.resolve(import.meta.dirname, '../..');
      const trees = yield* Effect.all(
        [`${owner}/api`, `${owner}/shared`, `${owner}/src`, 'packages'].map((folder) =>
          readPricingSourceTree(root, folder),
        ),
      );
      const runtimeDeclarationFile = `${owner}/vertical.runtime-declaration.ts`;
      const hasRuntimeDeclaration = yield* Effect.promise(() =>
        readFile(path.join(root, runtimeDeclarationFile), 'utf-8')
          .then(() => true)
          .catch(() => false),
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

it.live('counts the actual published Pricing read shim in exact owner inventory and rejects nearby escapes', () =>
  Effect.gen(function* actualPublishedPricingInventory() {
    const root = path.resolve(import.meta.dirname, '../..');
    const trees = yield* Effect.all(
      ['verticals/pricing', 'packages/pricing-contracts'].map((folder) => readPricingSourceTree(root, folder)),
    );
    const sources = new Map(trees.flat());
    const shared = PRICING_SHARED_API_PATH;
    const shimFile = 'verticals/pricing/shared/apis/quotation-verification.ts';
    const manifestFile = 'verticals/pricing/vertical.manifest.ts';
    const registrationFile = 'verticals/pricing/vertical.registration.ts';
    const packageFile = 'packages/pricing-contracts/package.json';
    const targetFile = 'packages/pricing-contracts/src/apis/quotation-verification.ts';
    const shim = sources.get(shimFile) ?? '';
    expect(shim.startsWith(MODULE_API_HEADER)).toBe(false);
    expect(hasPublishedGeneratedContractShim(sources, shimFile, shim)).toBe(true);
    const rootSource = sources.get(shared) ?? '';
    const handler = sources.get(PRICING_HANDLER_PATH) ?? '';
    const headerAnnotation = ".annotate(HttpApi.HeadersParseOptions, { onExcessProperty: 'ignore' })";
    expect(rootSource.includes(headerAnnotation)).toBe(true);
    expect(hasValidGovernedHttpCompositionRoot(rootSource, handler)).toBe(true);
    for (const invalid of [
      rootSource.replace('HttpApi.HeadersParseOptions', 'HttpApi.UnknownParseOptions'),
      rootSource.replace("from '@modern-js/bff-effect/effect-client'", "from './fake-http.ts'"),
      rootSource.replace(headerAnnotation, ".annotate(HttpApi.HeadersParseOptions, { onExcessProperty: 'error' })"),
      rootSource.replace(headerAnnotation, '.annotate(HttpApi.HeadersParseOptions, { ...untrusted })'),
      rootSource.replace(headerAnnotation, '.annotate(HttpApi.HeadersParseOptions, { onExcessProperty: configured })'),
      rootSource.replace(headerAnnotation, `${headerAnnotation}.pipe(unknownOperator)`),
      rootSource.replace("import { identity } from 'effect'", "import { identity } from './fake-effect.ts'"),
    ]) {
      expect(invalid).not.toBe(rootSource);
      expect(hasValidGovernedHttpCompositionRoot(invalid, handler)).toBe(false);
    }
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, 'pricing', diagnostics), diagnostics.join('\n')).toBe(
      true,
    );
    // The transitional v2 shape (O62, O68): the same protected read with no legacy permission target
    // and no positional resolver still satisfies the seam, including the empty trailing slot the
    // removal leaves behind (a trailing comma) and the explicit `undefined` placeholder that keeps a
    // later executable-policy argument in position.
    const readPath = 'verticals/pricing/src/api/quotation-verification.read.ts';
    const read = sources.get(readPath) ?? '';
    const withoutResolver = read
      .replace("    permissionTarget: 'module',\n", '')
      .replace("  () => ({ kind: 'module', moduleId: MODULE_KEY }),\n", '');
    expect(withoutResolver).not.toContain('permissionTarget');
    expect(withoutResolver).toContain('  servicesForScope,\n);');
    const v2Diagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [readPath, withoutResolver]]),
        shared,
        'pricing',
        v2Diagnostics,
      ),
      v2Diagnostics.join('\n'),
    ).toBe(true);
    const withPlaceholders = withoutResolver.replace(
      '  servicesForScope,\n);',
      '  servicesForScope,\n  undefined,\n  undefined,\n  [],\n);',
    );
    expect(withPlaceholders).not.toBe(withoutResolver);
    expect(
      hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, withPlaceholders]]), shared, 'pricing'),
    ).toBe(true);
    // Negative control: a legacy classification still has to name the permission target it is decided by,
    // so the same removal on a non-`protected` entrypoint is refused.
    const legacyRead = withoutResolver.replace(PROTECTED_READ_AUTHORIZATION, NON_PROTECTED_READ_AUTHORIZATION);
    expect(legacyRead).not.toBe(withoutResolver);
    expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, legacyRead]]), shared, 'pricing')).toBe(
      false,
    );
    // Module-to-module reads (DESIGN D5): a protected read whose only access carrier is `accessActor` decides
    // through the access gate like a declared read, so it needs no legacy target either. The pricing read
    // declares its module callers only, then the same carrier-free and non-protected variants must fail.
    const actorOnlyRead = withoutResolver.replace(carrierBlock('accessDeclaration'), '');
    expect(actorOnlyRead).not.toContain('accessDeclaration');
    expect(actorOnlyRead).toContain('accessActor: {');
    const actorDiagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [readPath, actorOnlyRead]]),
        shared,
        'pricing',
        actorDiagnostics,
      ),
      actorDiagnostics.join('\n'),
    ).toBe(true);
    const carrierless = actorOnlyRead.replace(carrierBlock('accessActor'), '');
    expect(carrierless).not.toContain('accessActor');
    expect(carrierless).not.toContain('accessDeclaration');
    expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, carrierless]]), shared, 'pricing')).toBe(
      false,
    );
    const actorNonProtected = actorOnlyRead.replace(PROTECTED_READ_AUTHORIZATION, NON_PROTECTED_READ_AUTHORIZATION);
    expect(actorNonProtected).not.toBe(actorOnlyRead);
    expect(
      hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, actorNonProtected]]), shared, 'pricing'),
    ).toBe(false);
    const pricingReadFile = 'verticals/pricing/src/api/current-pricing-decision.read.ts';
    const requirementsFile = 'verticals/pricing/src/integrations/pricing-operation-requirements.ts';
    const pricingRead = sources.get(pricingReadFile) ?? '';
    const requirements = sources.get(requirementsFile) ?? '';
    const option = '{ requirements: currentPricingDecisionRequirements }';
    const acceptsFactory = (changed: ReadonlyMap<string, string>) =>
      hasOwnerLocalReadServiceFactoryResult(
        changed,
        pricingReadFile,
        'verticals/pricing',
        'currentPricingDecisionReadServiceFactory',
      );
    expect(acceptsFactory(sources)).toBe(true);
    const invalidOptions: readonly (readonly [string, string])[] = [
      [
        pricingReadFile,
        pricingRead.replace(option, '{ ...suppliedOptions, requirements: currentPricingDecisionRequirements }'),
      ],
      [pricingReadFile, pricingRead.replace(option, '{ [optionKey]: currentPricingDecisionRequirements }')],
      [
        pricingReadFile,
        pricingRead.replace(option, '{ requirements: currentPricingDecisionRequirements, extra: capability }'),
      ],
      [
        pricingReadFile,
        pricingRead.replace(
          option,
          '{ pricingOwnerFinalFenceForScope: pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope }',
        ),
      ],
      [
        pricingReadFile,
        pricingRead.replace(
          'readonly requirements?: PricingWholeEvaluationRequirements',
          'requirements: PricingWholeEvaluationRequirements',
        ),
      ],
      [
        pricingReadFile,
        pricingRead.replace(
          "from '../integrations/pricing-operation-requirements.ts'",
          "from '../../../foreign/pricing-operation-requirements.ts'",
        ),
      ],
      [
        requirementsFile,
        requirements.replace(
          'export const currentPricingDecisionRequirements',
          'export let currentPricingDecisionRequirements',
        ),
      ],
      [requirementsFile, requirements.replace('assignedGroupCompatibility:', '[computedRequirement]:')],
      [
        requirementsFile,
        requirements.replace(
          "assignedGroupCompatibility: 'commerce.pricing.requirement.current-pricing-decision-assigned-group-compatibility'",
          'assignedGroupCompatibility: () => capability',
        ),
      ],
      [
        requirementsFile,
        requirements.replace(
          'export const currentPricingDecisionRequirements = {',
          'export const currentPricingDecisionRequirements = { ...unproven,',
        ),
      ],
      [requirementsFile, requirements.replace('} as const;', '};')],
      [requirementsFile, `${requirements}\nconst escaped = currentPricingDecisionRequirements;`],
      [requirementsFile, `${requirements}\ncapture(currentPricingDecisionRequirements);`],
    ];
    for (const [file, invalid] of invalidOptions) {
      expect(invalid).not.toBe(sources.get(file));
      expect(acceptsFactory(new Map([...sources, [file, invalid]])), invalid).toBe(false);
    }
    const invalidSources: readonly (readonly [string, string])[] = [
      [shimFile, `${shim}\nexport const runtime = true;`],
      [shimFile, shim.replace('@app/pricing-contracts/quotation-verification', '@app/pricing/src/private')],
      [
        manifestFile,
        (sources.get(manifestFile) ?? '').replace("'quotation-verification': QuotationVerificationApi,", ''),
      ],
      [
        registrationFile,
        (sources.get(registrationFile) ?? '').replace(
          "'quotation-verification': () => import('./src/api/quotation-verification-client.ts'),",
          '',
        ),
      ],
      [
        manifestFile,
        (sources.get(manifestFile) ?? '').replace(
          "'quotation-verification': QuotationVerificationApi,",
          "'quotation-verification': CurrentSupportedCurrenciesApi,",
        ),
      ],
      [
        packageFile,
        (sources.get(packageFile) ?? '').replace('"packageName": "@app/pricing"', '"packageName": "@app/wrong-owner"'),
      ],
      [targetFile, (sources.get(targetFile) ?? '').replace(NATIVE_HTTP_SOURCE_IMPORT, FAKE_HTTP_SOURCE_IMPORT)],
      [
        targetFile,
        (sources.get(targetFile) ?? '').replace('export const QuotationVerificationApi =', 'export const WrongApi ='),
      ],
    ];
    for (const [file, invalid] of invalidSources) {
      expect(invalid).not.toBe(sources.get(file));
      const changed = new Map([...sources, [file, invalid]]);
      expect(hasCompleteGeneratedModuleApiSeam(changed, shared, 'pricing')).toBe(false);
    }
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

const READ_CORE_IMPORT = "import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';\n";
const LAYER_ARGUMENT = ', () => Layer.empty);';
const HELPER_LOAD =
  '{ load: (input: unknown, context: ReadLoadContext<object>) => loadStock(input, context.scope.tenantId) }';
/** A staged owner pipeline around `load`: its load step is proven local. */
const stagedPipeline = (load: string): string =>
  `{ prepare: () => Effect.succeed('ready'), load: ${load}, finish: (_input: unknown, context: ReadFinishContext<string, object>) => Effect.succeed(context.loaded) }`;

it.live(
  'accepts a bare read handler or a { prepare, load, finish } owner pipeline and rejects any other owner work',
  Effect.fn(function* readOwnerPipelineGate() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const bareRead = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
    const bareHandler = '() => Effect.succeed({}), () => Layer.empty);';
    expect(bareRead).toContain(bareHandler);
    expect(bareRead).toContain(READ_CORE_IMPORT);
    // A staged load step is proven local, so its `Effect` is the real import, as in every Read module.
    const withOwnerWork = (ownerWork: string): string =>
      bareRead
        .replace(READ_CORE_IMPORT, `${READ_CORE_IMPORT}import { Effect } from 'effect';\n`)
        .replace(bareHandler, `${ownerWork}, () => Layer.empty);`);
    for (const accepted of [
      bareRead,
      withOwnerWork('{ load: () => Effect.succeed({}) }'),
      withOwnerWork(
        "{ prepare: () => Effect.succeed('ready'), load: () => Effect.succeed({}), finish: () => Effect.succeed({}) }",
      ),
    ]) {
      yield* write(root, STOCK_LIST_READ_FILE, accepted);
      yield* checkModuleEntrypointBoundaries(root);
    }
    yield* assertRejectedSources(
      root,
      STOCK_LIST_READ_FILE,
      [
        withOwnerWork('{ load: () => Effect.succeed({}), extra: () => Effect.succeed({}) }'),
        withOwnerWork("{ prepare: () => Effect.succeed('ready') }"),
        withOwnerWork('{ load: 42 }'),
        withOwnerWork('{ load: () => Effect.succeed({}), load: () => Effect.succeed({}) }'),
        withOwnerWork('{ load: () => Effect.succeed({}), finish: 42 }'),
        withOwnerWork('{ ...{ load: () => Effect.succeed({}) } }'),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
  }),
);

it.live(
  'accepts a load step that calls an Effect.fn const of the same module and rejects work it cannot see',
  Effect.fn(function* readLoadHelperGate() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const bareRead = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
    const bareHandler = `() => Effect.succeed({})${LAYER_ARGUMENT}`;
    expect(bareRead).toContain(bareHandler);
    expect(bareRead).toContain(READ_CORE_IMPORT);
    const effectFnHelper =
      "export const loadStock = Effect.fn('StockList.load')(function* loadStock(input: unknown, tenantId: string) {\n  return yield* Effect.succeed({ input, tenantId });\n});\n";
    const withLoad = (load: string, helper: string, imports = ''): string => {
      const read = bareRead
        .replace(READ_CORE_IMPORT, READ_CORE_IMPORT + imports)
        .replace(bareHandler, load + LAYER_ARGUMENT);
      return `${read}\n${helper}`;
    };
    yield* write(
      root,
      STOCK_LIST_READ_FILE,
      withLoad(HELPER_LOAD, effectFnHelper, "import { Effect } from 'effect';\n"),
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* assertRejectedSources(
      root,
      STOCK_LIST_READ_FILE,
      [
        withLoad(HELPER_LOAD, '', "import { loadStock } from './stock-load.ts';\n"),
        withLoad(
          HELPER_LOAD,
          'export const loadStock = (input: unknown, tenantId: string) => Effect.succeed({ input, tenantId });\n',
        ),
        withLoad(
          HELPER_LOAD,
          'export function loadStock(input: unknown, tenantId: string) {\n  return Effect.succeed({ input, tenantId });\n}\n',
        ),
        withLoad(HELPER_LOAD, `${effectFnHelper}loadStock = otherStockWork;\n`),
        withLoad(
          HELPER_LOAD,
          `${effectFnHelper}function loadStock(input: unknown) {\n  return otherStockWork(input);\n}\n`,
        ),
        withLoad(HELPER_LOAD, effectFnHelper, "import { loadStock } from './stock-load.ts';\n"),
        withLoad(
          '{ load: (loadStock: unknown, context: ReadLoadContext<object>) => loadStock(context) }',
          effectFnHelper,
        ),
        withLoad(
          '{ load: (input: unknown, context: ReadLoadContext<object>) => loadStock(input, otherStockWork(context)) }',
          effectFnHelper,
        ),
        withLoad(
          '{ load: (input: unknown) => { const loadStock = otherStockWork; return loadStock(input); } }',
          effectFnHelper,
        ),
        withLoad(
          HELPER_LOAD,
          "export const loadStock = Effect.fn('StockList.load')(function* loadStock(input: unknown, tenantId: string) {\n  return otherStockWork(input, tenantId);\n});\n",
        ),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
  }),
);

const stockLoadHelper = (body: string): string =>
  [
    "export const loadStock = Effect.fn('StockList.load')(function* loadStock(input: unknown, tenantId: string) {",
    body,
    '});',
    '',
  ].join('\n');

it.live(
  'refuses a same-module load helper whose work, directly or through other code, reaches anything but proven local code',
  Effect.fn(function* readLoadHelperForeignWork() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const bareRead = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
    const bareHandler = `() => Effect.succeed({})${LAYER_ARGUMENT}`;
    const remoteImport = "import { fetchRemoteStock } from '../integrations/remote-stock.ts';\n";
    const withHelper = (declarations: string, imports = ''): string =>
      [
        bareRead
          .replace(READ_CORE_IMPORT, `${READ_CORE_IMPORT}import { Effect } from 'effect';\n${imports}`)
          .replace(bareHandler, HELPER_LOAD + LAYER_ARGUMENT),
        declarations,
      ].join('\n');
    const revisionImport = "import { stockRevision } from '../stock-revision.ts';\n";
    const revisionHelper = stockLoadHelper('  return yield* Effect.succeed(stockRevision(input));');
    yield* write(
      root,
      'verticals/inventory-stock/src/integrations/remote-stock.ts',
      "import { Effect } from 'effect';\nexport const fetchRemoteStock = (input: unknown, tenantId: string) =>\n  Effect.promise(() => fetch('https://stock.example/' + tenantId, { body: JSON.stringify(input) }));\n",
    );
    yield* write(
      root,
      'verticals/inventory-stock/src/stock-revision.ts',
      "export const stockRevision = (value: unknown): string => JSON.stringify(value) ?? '';\n",
    );
    // The shape the governed price-group read relies on: a helper that reads only its parameters, `effect`,
    // core read errors and same-module or same-owner code that is itself proven local.
    yield* write(
      root,
      STOCK_LIST_READ_FILE,
      withHelper(
        [
          "const missing = () => new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'missing' });",
          'const revisionOf = (value: unknown) => stockRevision([value]);',
          stockLoadHelper(
            "  if (tenantId === '') {\n    return yield* missing();\n  }\n  const { found } = yield* Effect.succeed({ found: input });\n  return { found, revision: revisionOf(found) };",
          ),
        ].join('\n'),
        `import { ReadHandlerNotFound } from '@app/core-runtime';\n${revisionImport}`,
      ),
    );
    yield* checkModuleEntrypointBoundaries(root);
    yield* assertRejectedSources(
      root,
      STOCK_LIST_READ_FILE,
      [
        // The helper yields an imported remote operation.
        withHelper(stockLoadHelper('  return yield* fetchRemoteStock(input, tenantId);'), remoteImport),
        // The helper calls a second local helper, which does the remote work.
        withHelper(
          [
            "const remoteStock = Effect.fn('StockList.remote')(function* remoteStock(input: unknown, tenantId: string) {",
            '  return yield* fetchRemoteStock(input, tenantId);',
            '});',
            stockLoadHelper('  return yield* remoteStock(input, tenantId);'),
          ].join('\n'),
          remoteImport,
        ),
        withHelper(
          stockLoadHelper('  return yield* fetchRemoteStock(input, tenantId).pipe(Effect.orDie);'),
          remoteImport,
        ),
        withHelper(
          [
            'const remoteStock = fetchRemoteStock;',
            stockLoadHelper('  return yield* remoteStock(input, tenantId);'),
          ].join('\n'),
          remoteImport,
        ),
        withHelper(
          ['let remoteStock = Effect.succeed;', stockLoadHelper('  return yield* remoteStock(input);')].join('\n'),
        ),
        // A block-scoped shadow does not hide the import read after the block.
        withHelper(
          stockLoadHelper(
            '  {\n    const fetchRemoteStock = Effect.succeed;\n    yield* fetchRemoteStock(input);\n  }\n  return yield* fetchRemoteStock(input, tenantId);',
          ),
          remoteImport,
        ),
        withHelper(
          stockLoadHelper("  return yield* Effect.promise(() => fetch('https://stock.example/' + tenantId));"),
        ),
        withHelper(stockLoadHelper('  return yield* Effect.promise(() => globalThis.fetch(String(input)));')),
        withHelper(stockLoadHelper("  return yield* Effect.promise(() => import('../integrations/remote-stock.ts'));")),
        withHelper(stockLoadHelper("  return yield* Effect.succeed(Effect.succeed.constructor('return fetch')());")),
        withHelper(stockLoadHelper('  return yield* Effect.succeed(this);')),
        withHelper(
          stockLoadHelper('  return yield* remote.fetchRemoteStock(input, tenantId);'),
          "import * as remote from '../integrations/remote-stock.ts';\n",
        ),
        withHelper(
          stockLoadHelper('  return yield* HttpClient.get(String(input));'),
          "import { HttpClient } from 'effect/unstable/http';\n",
        ),
        withHelper(
          stockLoadHelper('  return yield* Effect.succeed(remoteRevision(input));'),
          "import { remoteRevision } from '../stock-revision.ts';\n",
        ),
      ],
      /module APIs require an approved Codesmith generator/u,
    );
    // A same-owner module is proven by its own content: one that reaches a global outside the pure set refuses.
    yield* write(
      root,
      'verticals/inventory-stock/src/stock-revision.ts',
      'export const stockRevision = (value: unknown): string => String(new TextEncoder().encode(String(value)));\n',
    );
    yield* assertRejectedSources(
      root,
      STOCK_LIST_READ_FILE,
      [withHelper(revisionHelper, revisionImport)],
      /module APIs require an approved Codesmith generator/u,
    );
  }),
);

it.live(
  'refuses load work that reaches ambient services, the Function constructor or remote code through an allowed name, inline or in a helper',
  Effect.fn(function* readLoadWorkEscapes() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const bareRead = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
    const bareHandler = `() => Effect.succeed({})${LAYER_ARGUMENT}`;
    const remoteImport = "import { fetchRemoteStock } from '../integrations/remote-stock.ts';\n";
    const withOwnerWork = (ownerWork: string, declarations = '', imports = ''): string =>
      [
        bareRead
          .replace(READ_CORE_IMPORT, `${READ_CORE_IMPORT}import { Effect, Struct } from 'effect';\n${imports}`)
          .replace(bareHandler, ownerWork + LAYER_ARGUMENT),
        declarations,
      ].join('\n');
    const withHelper = (body: string): string => withOwnerWork(HELPER_LOAD, stockLoadHelper(body));
    yield* write(
      root,
      'verticals/inventory-stock/src/integrations/remote-stock.ts',
      "import { Effect } from 'effect';\nexport const fetchRemoteStock = (input: unknown, tenantId: string) =>\n  Effect.promise(() => fetch('https://stock.example/' + tenantId, { body: JSON.stringify(input) }));\n",
    );
    // Load work that reads only its parameters, owner services on them, and pure Effect members still passes.
    const verdicts = Effect.fn(function* loadWorkVerdicts(sources: readonly string[]) {
      const passed: number[] = [];
      for (const [index, source] of sources.entries()) {
        yield* write(root, STOCK_LIST_READ_FILE, source);
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        if (Exit.isSuccess(result)) {
          passed.push(index);
        } else {
          expect(Cause.pretty(result.cause), `source ${index}`).toMatch(
            /module APIs require an approved Codesmith generator/u,
          );
        }
      }
      return passed;
    });
    const allowed = [
      withOwnerWork(
        stagedPipeline(
          '(input: unknown, context: ReadLoadContext<{ find: (input: unknown) => Effect.Effect<object> }, string>) => context.services.find(input).pipe(Effect.map((found) => ({ found, prepared: context.prepared })))',
        ),
      ),
      withOwnerWork(
        stagedPipeline(
          "Effect.fn('StockList.load')(function* load(input: unknown, context: ReadLoadContext<object, string>) {\n  const rows = yield* Effect.succeed([input]);\n  return { first: rows[0], count: rows.length, tenantId: context.scope.tenantId };\n})",
        ),
      ),
      withHelper('  return yield* Effect.succeed({ found: Object.keys({ input }), tenantId });'),
    ];
    expect(yield* verdicts(allowed), 'proven load work the gate refused').toEqual(
      allowed.map((_source, index) => index),
    );
    const refused = [
      // A non-literal computed key reaches the Function constructor and, through it, fetch.
      withHelper(
        "  const key = ['constr', 'uctor'].join('');\n  const make = Effect.succeed[key]('return fetch')();\n  return yield* Effect.promise(() => make('https://stock.example/' + tenantId));",
      ),
      withHelper(
        "  const key = ['constr', 'uctor'].join('');\n  return yield* Effect.sync(() => Effect.succeed[key]('return fetch')()('https://stock.example/' + tenantId));",
      ),
      // Effect hands the helper every ambient service.
      withHelper(
        '  const probeContext = yield* Effect.context<never>();\n  const probeAll = Array.from((probeContext as any).mapUnsafe.values());\n  return yield* (probeAll[0] as any).resolveCurrent(input);',
      ),
      withHelper('  const services = yield* Effect.services<never>();\n  return services;'),
      withHelper('  return yield* Effect.tryPromise(() => Promise.resolve(tenantId));'),
      // Effect or Object as a value hands out members the proof never sees by name.
      withHelper(
        "  const members = Object.entries(Effect).find(([name]) => name === 'context');\n  return yield* (members as any)[1]();",
      ),
      withHelper(
        "  const fn = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(Effect.succeed))).find((d: any) => d.value?.name === 'Function');\n  return yield* Effect.sync(() => (fn as any).value('return fetch')()(tenantId));",
      ),
      withHelper('  const E = Effect;\n  return yield* E.succeed(input);'),
      // A destructured prototype key, or a module member that reads a key it is passed.
      withHelper(
        "  const { constructor: make } = (() => tenantId);\n  return yield* Effect.sync(() => make('return fetch')()(tenantId));",
      ),
      withHelper(
        "  return yield* Effect.sync(() => Struct.get(['constr', 'uctor'].join(''))(() => tenantId)('return fetch')()(tenantId));",
      ),
      // The same remote work written inline in a staged load, or in a const the load step names.
      withOwnerWork(
        stagedPipeline(
          '(input: unknown, context: ReadLoadContext<object, string>) => Effect.gen(function* inlineProbe() {\n  return yield* fetchRemoteStock(input, context.scope.tenantId);\n})',
        ),
        '',
        remoteImport,
      ),
      withOwnerWork(
        stagedPipeline(
          '(input: unknown, context: ReadLoadContext<object, string>) => fetchRemoteStock(input, context.scope.tenantId)',
        ),
        '',
        remoteImport,
      ),
      withOwnerWork(
        stagedPipeline('readRemoteStock'),
        "const readRemoteStock = Effect.fn('StockList.load')(function* readRemoteStock(input: unknown, context: ReadLoadContext<object, string>) {\n  return yield* fetchRemoteStock(input, context.scope.tenantId);\n});\n",
        remoteImport,
      ),
      withOwnerWork(
        stagedPipeline(
          '(input: unknown, context: ReadLoadContext<object, string>) => Effect.gen(function* inlineProbe() {\n  return yield* Effect.context<never>();\n})',
        ),
      ),
    ];
    expect(yield* verdicts(refused), 'load-work escapes the gate accepted').toEqual([]);
  }),
);

/** The indexes of `sources` the gate accepts as the stock-list Read; every refusal is the generator diagnostic. */
const acceptedReadSources = Effect.fn(function* acceptedReadSources(root: string, sources: readonly string[]) {
  const passed: number[] = [];
  for (const [index, source] of sources.entries()) {
    yield* write(root, STOCK_LIST_READ_FILE, source);
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    if (Exit.isSuccess(result)) {
      passed.push(index);
    } else {
      expect(Cause.pretty(result.cause), `source ${index}`).toMatch(
        /module APIs require an approved Codesmith generator/u,
      );
    }
  }
  return passed;
});

it.live(
  'admits only the named hash and encoding exports the staged reads use, and the clock only as DateTime.now',
  Effect.fn(function* readLoadWorkPureImports() {
    const root = yield* makeFixture();
    yield* writeGovernedModuleApi(root);
    const bareRead = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
    const bareHandler = `() => Effect.succeed({})${LAYER_ARGUMENT}`;
    const withHelper = (body: string, imports: string): string =>
      [
        bareRead
          .replace(READ_CORE_IMPORT, `${READ_CORE_IMPORT}import { DateTime, Effect } from 'effect';\n${imports}`)
          .replace(bareHandler, HELPER_LOAD + LAYER_ARGUMENT),
        stockLoadHelper(body),
      ].join('\n');
    const hashImports =
      "import { sha256 } from '@noble/hashes/sha2.js';\nimport { utf8ToBytes } from '@noble/hashes/utils.js';\nimport { Hex } from 'effect/encoding';\n";
    const accepted = [
      withHelper(
        '  return yield* Effect.succeed(Hex.encode(sha256(utf8ToBytes(String(input) + tenantId))));',
        hashImports,
      ),
      withHelper('  return DateTime.formatIso(yield* DateTime.now);', ''),
    ];
    expect(yield* acceptedReadSources(root, accepted), 'pure imports the gate refused').toEqual([0, 1]);
    const refused = [
      withHelper(
        '  return yield* Effect.succeed(randomBytes(16));',
        "import { randomBytes } from '@noble/hashes/utils.js';\n",
      ),
      withHelper(
        '  return yield* Effect.succeed(sha512(utf8ToBytes(tenantId)));',
        "import { sha512 } from '@noble/hashes/sha2.js';\nimport { utf8ToBytes } from '@noble/hashes/utils.js';\n",
      ),
      withHelper(
        '  return yield* Effect.succeed(sha256(utf8ToBytes(tenantId)));',
        "import { sha256 } from '@noble/hashes/sha256.js';\nimport { utf8ToBytes } from '@noble/hashes/utils.js';\n",
      ),
      withHelper('  return yield* Effect.succeed(Hex.decode(tenantId));', "import { Hex } from 'effect/encoding';\n"),
      withHelper(
        '  return yield* Effect.succeed(Base64.encode(utf8ToBytes(tenantId)));',
        "import { Base64 } from 'effect/encoding';\nimport { utf8ToBytes } from '@noble/hashes/utils.js';\n",
      ),
      withHelper('  return yield* DateTime.nowAsDate;', ''),
      withHelper('  return yield* Clock.currentTimeMillis;', "import { Clock } from 'effect';\n"),
    ];
    expect(yield* acceptedReadSources(root, refused), 'ambient or unlisted imports the gate accepted').toEqual([]);
  }),
);
