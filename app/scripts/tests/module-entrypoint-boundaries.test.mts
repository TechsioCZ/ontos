import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit, Match } from 'effect';
import { expect, it } from 'effect-rstest';
import { validateGatewayIssuerEntrypoints } from '../check-module-entrypoint-boundaries.mts';
import { gatewayContextAuthorizationEntrypoints } from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasOwnerLocalReadServiceFactory,
  hasGeneratedGovernedServerContract,
} from '../generated-governed-http-boundary.mts';
import {
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
  publishedResourceRefContractExports,
  resolvePublishedContractModuleId,
} from '../published-outbox-contracts.mts';
import {
  CUSTOMER_CONTEXT_VERTICAL_PATH,
  CATALOG_VERTICAL_PATH,
  STOCK_LIST_SERVER_CONTRACT_IMPORT,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_MODULE_ID,
  STOCK_LIST_CLIENT_CONTRACT_IMPORT,
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
  'checks a read published from its contract package with no owner file and rejects every owner forwarder or broken claim',
  () =>
    Effect.gen(function* publishedPackageRead() {
      const root = yield* makeFixture();
      yield* writeGovernedModuleApi(root);
      const owner = INVENTORY_VERTICAL_PATH;
      const contractPackage = 'packages/inventory-public-contracts';
      const specifier = '@app/inventory-public-contracts/stock-list';
      const ownerContract = `${owner}/shared/apis/stock-list.ts`;
      const ownerClient = `${owner}/src/api/stock-list-client.ts`;
      const packageFile = `${contractPackage}/package.json`;
      const readText = (file: string) => Effect.promise(() => readFile(path.join(root, file), 'utf-8'));
      const metadata = {
        exports: {
          './stock-list': './src/apis/stock-list.ts',
          './stock-list/client': './src/api/stock-list-client.ts',
        },
        name: '@app/inventory-public-contracts',
        ontosContractOwner: {
          appId: INVENTORY_DEPLOYMENT_ID,
          moduleApis: [STOCK_LIST_STEM],
          moduleId: INVENTORY_MODULE_ID,
          packageName: INVENTORY_PACKAGE_SPECIFIER,
        },
      };
      const contract = yield* readText(ownerContract);
      const client = yield* readText(ownerClient);
      yield* write(root, `${contractPackage}/src/apis/stock-list.ts`, contract);
      yield* write(
        root,
        `${contractPackage}/src/api/stock-list-client.ts`,
        client.replaceAll(STOCK_LIST_CLIENT_CONTRACT_IMPORT, '../apis/stock-list.ts'),
      );
      yield* write(
        root,
        `${contractPackage}/src/api/action-gateway.ts`,
        yield* readText(`${owner}/src/api/action-gateway.ts`),
      );
      yield* write(root, packageFile, JSON.stringify(metadata));
      yield* Effect.promise(() => Promise.all([ownerContract, ownerClient].map((file) => rm(path.join(root, file)))));
      for (const [file, from, to] of [
        [`${owner}/shared/api.ts`, './apis/stock-list.ts', specifier],
        [`${owner}/vertical.manifest.ts`, './shared/apis/stock-list.ts', specifier],
        [`${owner}/vertical.registration.ts`, './src/api/stock-list-client.ts', `${specifier}/client`],
        [`${owner}/api/stock-list-read-server.ts`, STOCK_LIST_SERVER_CONTRACT_IMPORT, specifier],
      ] as const) {
        const source = yield* readText(file);
        expect(source, file).toContain(from);
        yield* write(root, file, source.replaceAll(from, to));
      }
      yield* checkModuleEntrypointBoundaries(root);
      const shim = `${MODULE_API_HEADER}// An ordinary ownership comment does not carry executable capabilities.\nexport * from '${specifier}';\n`;
      for (const [file, invalid] of [
        [ownerContract, shim],
        [ownerContract, `${shim}export const mutable = true;`],
        [ownerContract, shim.replace('export *', "import { runtime } from './private.ts'; export *")],
        [ownerContract, shim.replace(specifier, '@app/private-implementation/stock-list')],
        [
          ownerContract,
          shim.replace(
            '// An ordinary ownership comment does not carry executable capabilities.',
            '// @ontos-public-contract @app/other/stock-list',
          ),
        ],
        [ownerClient, `${MODULE_API_HEADER}export * from '${specifier}/client';\n`],
      ] as const) {
        yield* write(root, file, invalid);
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        expect(Exit.isFailure(result), invalid).toBe(true);
        yield* Effect.promise(() => rm(path.join(root, file)));
      }
      yield* checkModuleEntrypointBoundaries(root);
      for (const invalid of [
        { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, moduleId: 'other.owner' } },
        { ...metadata, exports: { ...metadata.exports, './stock-list': '../outside.ts' } },
        { ...metadata, ontosContractOwner: { ...metadata.ontosContractOwner, moduleApis: [] } },
      ]) {
        yield* write(root, packageFile, JSON.stringify(invalid));
        const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
        expect(Exit.isFailure(result)).toBe(true);
      }
    }),
);

/** The modules whose published module-api contracts these owners' reads call, read where those contracts are declared. */
const PUBLISHING_PROVIDERS = ['verticals/commerce-market-catalog', 'verticals/party-registry'] as const;

for (const owner of [CATALOG_VERTICAL_PATH, CUSTOMER_CONTEXT_VERTICAL_PATH]) {
  it.live(`proves the full native operationContracts array for ${owner}, independent of marker placement`, () =>
    Effect.gen(function* nativeOwnerOperationInventory() {
      const root = path.resolve(import.meta.dirname, '../..');
      const trees = yield* Effect.all(
        [`${owner}/api`, `${owner}/shared`, `${owner}/src`, 'packages', ...PUBLISHING_PROVIDERS].map((folder) =>
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
