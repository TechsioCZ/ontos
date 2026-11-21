import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasGeneratedActionHttpRunnerBinding,
  hasPublishedGeneratedActionContractShim,
  hasGeneratedGovernedServerContract,
} from '../generated-governed-http-boundary.mts';
import { hasGeneratedModuleApiContract, hasGeneratedSourceHeader } from '../generated-module-api-boundary.mts';
import { assertPublishedOutboxContractSource } from '../published-outbox-contracts.mts';
import {
  PRIVATE_COLOCATED_CALLABLE_CASE,
  PARTY_VERTICAL_PATH,
  PRIVACY_VERTICAL_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_DEPENDENCY_VERSION,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  APP_PACKAGE_LINK_DIRECTORY,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  VERTICALS_WORKSPACE_DECLARATION,
  SHARED_CONTRACTS_PACKAGE_JSON_PATH,
  SHARED_PROBLEM_DETAILS_SOURCE_PATH,
  SHARED_CONTRACTS_WORKSPACE_NAME,
  SHARED_CONTRACTS_WORKSPACE_PATH,
  BOUNDARY_FIXTURE_TOPOLOGY,
  BOUNDARY_FIXTURE_SHELL_ID,
  BOUNDARY_FIXTURE_SHELL_PATH,
  STOCK_LIST_SERVER_CONTRACT_IMPORT,
  INVENTORY_DEPLOYMENT_ID,
  STOCK_LIST_CLIENT_CONTRACT_IMPORT,
  INVENTORY_AUDIENCE_OPTION,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_MODULE_ID,
  RESERVE_PUBLISHED_SOURCE,
  STOCK_LIST_PUBLISHED_SOURCE,
  UNUSED_NATIVE_API_DECLARATION,
  NATIVE_HTTP_SOURCE_IMPORT,
  FAKE_HTTP_SOURCE_IMPORT,
  CORE_RUNTIME_SOURCE_IMPORT,
  FAKE_CORE_SOURCE_IMPORT,
  EXPECTED_EFFECT_FAILURE,
  GOVERNED_SEARCH_HEADER,
  checkModuleEntrypointBoundaries,
  READ_ACCESS_SOURCE,
  PUBLIC_AUTHORIZATION_SOURCE,
  protectedAuthorizationSource,
  AUTHENTICATE_PRINCIPAL_BINDING,
  STOCK_LIST_STEM,
  GATEWAY_CONTRACT_FILE,
  STOCK_LIST_READ_FILE,
  GATEWAY_BYPASS_MARKER,
  GATEWAY_INVOKE_MARKER,
  GATEWAY_IMPORT,
  CLIENT_CONFIG_DECLARATION,
  INVENTORY_CONTRACT_IMPORT,
  OPTIONS_CALL_TAIL,
  AUTHORIZATION_VALUE,
  AUTHORIZATION_VALUE_TAIL,
  CORRELATION_VALUE,
  CORRELATION_VALUE_TAIL,
  DEFAULT_API_PREFIX,
  DEFAULT_API_PREFIX_TAIL,
  SCHEMA_VERSION_ONE,
  MODULE_API_HEADER,
  MANIFEST_SEARCH_END,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_CLIENT_SOURCE_PATH,
  PARTY_MODULE_ID,
  PARTY_OUTBOX_SPECIFIER,
  INVENTORY_VERTICAL_PATH,
  INVENTORY_REGISTRATION_PATH,
  INVENTORY_RUNTIME_ID,
  write,
  governedClientFixture,
  problemKinds,
  governedServerFixture,
  moduleContractFixture,
  assertRejectedSources,
  makeFixture,
  ENGAGEMENT_REGISTRATION_FILE,
  ENGAGEMENT_REJECTION,
  writeEngagementLifecycleFixture,
  writeGovernedModuleApi,
  partyResourceSource,
  partyClientSource,
  generatedPartyDetailClientSource,
  generatedPartyCommandClientSource,
  assertPublishedPartyUsage,
  partyOutboxSource,
  readPricingSourceTree,
  makePortalPublicRoleFixture,
  makeActualCatalogSelectionFixture,
  makeActualPartyClientFixture,
  makeActualPrivacyClientFixture,
} from './module-entrypoint-boundary-fixtures.mts';

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

it.live('accepts governed generated Actions, pages, Workers, catalogs, and route manifests', () =>
  Effect.gen(function* testEffect3() {
    const root = yield* makeFixture();
    yield* checkModuleEntrypointBoundaries(root);
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
    // Each contract case below must fail on the contract alone, never on a client left invalid above.
    yield* write(root, clientPath, validClient);
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
    const pipedDecoy = validContract.replace(
      "HttpApi.make('StockListApi').add(",
      `HttpApi.make('StockListApi')
  .pipe((api) => {
    DecoyApi.add(HttpApiGroup.make('decoy'));
    return api;
  })
  .add(`,
    );
    expect(pipedDecoy).not.toBe(validContract);
    yield* write(root, contractPath, pipedDecoy);
    yield* write(root, clientPath, validClient.replace('client.stockList.execute', 'client.decoy.execute'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    const detachedContract = validContract.replace(/\.add\(HttpApiGroup\.make\('stockList'\)[\s\S]*?\}\)\)\)/u, '');
    expect(detachedContract).not.toBe(validContract);
    yield* write(root, contractPath, `${detachedContract}\nDecoyApi.add(HttpApiGroup.make('decoy'));`);
    yield* write(root, clientPath, validClient.replace('client.stockList.execute', 'client.decoy.execute'));
    yield* Effect.matchCause(checkModuleEntrypointBoundaries(root), {
      onFailure: (cause) =>
        expect(String(Cause.squash(cause))).toMatch(/module APIs require an approved Codesmith generator/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* write(root, clientPath, validClient);
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

it('rejects a ResourceRef contract with a spoofed Codesmith header', () => {
  expect(() =>
    assertPublishedPartyUsage({
      readExportSource: () => partyResourceSource.replace('OntOS Codesmith Resource v1', 'handmade'),
    }),
  ).toThrow(/must remain a generated schema-only ResourceRef contract/u);
});

it('rejects a ResourceRef import without the consuming workspace dependency', () => {
  expect(() => assertPublishedPartyUsage({ dependencyDeclared: false })).toThrow(
    /must declare @app\/party-registry as a workspace dependency/u,
  );
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

it('keeps executable owner behavior out of published Outbox contracts', () => {
  expect(() =>
    assertPublishedOutboxContractSource({
      moduleId: PARTY_MODULE_ID,
      source: `${partyOutboxSource}import { handler } from '../../src/actions/create-party.action.ts';\n`,
      specifier: PARTY_OUTBOX_SPECIFIER,
    }),
  ).toThrow(/must remain a generated schema-only Outbox contract/u);
});

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

it('classifies only exact published Action HTTP contract shims and no read forwarder', () => {
  const owner = INVENTORY_VERTICAL_PATH;
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
  const acceptsRead = (source = readShim) => hasPublishedGeneratedActionContractShim(sources, readContractFile, source);
  const acceptsAction = (source = actionShim) => hasPublishedGeneratedActionContractShim(sources, actionFile, source);
  // A module read is published from its package with no owner file; an owner read forwarder is never accepted.
  expect(acceptsRead()).toBe(false);
  expect(acceptsAction()).toBe(true);
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
    { ...metadata, exports: { ...metadata.exports, './reserve-action': '../private.ts' } },
  ]) {
    sources.set(packageFile, JSON.stringify(invalid));
    expect(acceptsAction()).toBe(false);
  }
  sources.set(packageFile, JSON.stringify(metadata));
  sources.set('packages/ambiguous/package.json', JSON.stringify(metadata));
  expect(acceptsAction()).toBe(false);
});

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

it.live('accepts the reviewed Privacy notice-presentation GET companion only as its exact pinned text', () =>
  Effect.gen(function* actualPrivacyNoticePresentationCompanion() {
    const root = path.resolve(import.meta.dirname, '../..');
    const sources = new Map(yield* readPricingSourceTree(root, PRIVACY_VERTICAL_PATH));
    const shared = 'verticals/privacy/shared/api.ts';
    const contractFile = 'verticals/privacy/shared/apis/notice-presentation.ts';
    const serverFile = 'verticals/privacy/api/notice-presentation-read-server.ts';
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, 'privacy', diagnostics), diagnostics.join('\n')).toBe(
      true,
    );
    const contract = sources.get(contractFile) ?? '';
    const server = sources.get(serverFile) ?? '';
    expect(contract).toContain("HttpApiEndpoint.get('present'");
    expect(server).toContain(".handle('present'");
    const invalidSources: readonly (readonly [string, string])[] = [
      [contractFile, contract.replace('/notices/:noticeVersionId/presentation', '/notices/:noticeVersionId/other')],
      [contractFile, contract.replace("HttpApiEndpoint.get('present'", "HttpApiEndpoint.get('presentAny'")],
      [serverFile, server.replace("x-correlation-id'", "x-other-id'")],
      [serverFile, server.replace('authenticateOperationPrincipal(', 'authenticateUnverifiedPrincipal(')],
      [serverFile, server.replace("'cache-control', 'no-store'", "'cache-control', 'public'")],
      [serverFile, `${server}\nexport const extraPresentationSurface = true;`],
    ];
    for (const [file, invalid] of invalidSources) {
      expect(invalid).not.toBe(sources.get(file));
      expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [file, invalid]]), shared, 'privacy')).toBe(false);
    }
  }),
);

it.live('preserves the actual public portal-auth schemas and approved typed verification client', () =>
  Effect.gen(function* actualPortalPublicRoles() {
    const root = yield* makePortalPublicRoleFixture();
    yield* checkModuleEntrypointBoundaries(root);
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

const PRIVATE_ROUTINE_SOURCE = 'export const privateRoutine = () => true;\n';
const CATALOG_PRIVATE_ROUTINE = 'verticals/catalog/src/handlers/private-contract.ts';

const VALUE_ONLY_CLAIM = { moduleApis: [], moduleId: 'commerce.catalog', packageName: '@app/catalog' } as const;

it.live('rejects a vertical that claims another deployment identity as a value-only contract owner', () =>
  Effect.gen(function* verticalClaimingForeignIdentity() {
    const root = yield* makeActualCatalogSelectionFixture();
    const manifest = 'verticals/inventory/package.json';
    yield* write(
      root,
      manifest,
      JSON.stringify({
        name: INVENTORY_PACKAGE_SPECIFIER,
        ontosContractOwner: { ...VALUE_ONLY_CLAIM, appId: 'catalog' },
      }),
    );
    // With the claimed identity, Inventory would read Catalog's private source as its own.
    yield* write(root, CATALOG_PRIVATE_ROUTINE, PRIVATE_ROUTINE_SOURCE);
    yield* write(
      root,
      'verticals/inventory/shared/catalog-private-consumer.ts',
      "import { privateRoutine } from '../../catalog/src/handlers/private-contract.ts';\nexport const run = privateRoutine;\n",
    );
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        `${manifest}: a value-only ontosContractOwner claims catalog's identity`,
      );
    }
  }),
);

it.live("rejects a value-only contract package that imports its owner's private source", () =>
  Effect.gen(function* kernelReachingOwnerPrivateSource() {
    const root = yield* makeActualCatalogSelectionFixture();
    const kernelFile = 'packages/catalog-selection-contracts/src/domain/private-reach.ts';
    const privateOrigin = CATALOG_PRIVATE_ROUTINE;
    yield* write(root, privateOrigin, PRIVATE_ROUTINE_SOURCE);
    yield* write(
      root,
      kernelFile,
      "import { privateRoutine } from '../../../../verticals/catalog/src/handlers/private-contract.ts';\nexport const run = privateRoutine;\n",
    );
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(kernelFile);
      expect(Cause.pretty(result.cause)).toContain(privateOrigin);
    }
  }),
);

it.live('rejects a value-only contract package that names an owner the topology does not know', () =>
  Effect.gen(function* packageClaimingUnknownOwner() {
    const root = yield* makeActualCatalogSelectionFixture();
    const manifest = 'packages/billing-value-contracts/package.json';
    yield* write(
      root,
      manifest,
      JSON.stringify({
        exports: { './value': './src/value.ts' },
        name: '@app/billing-value-contracts',
        ontosContractOwner: { ...VALUE_ONLY_CLAIM, appId: 'billing' },
      }),
    );
    yield* write(root, 'packages/billing-value-contracts/src/value.ts', "export const billingValue = 'value';\n");
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        `${manifest}: a value-only ontosContractOwner names owner billing, which the topology does not know`,
      );
    }
  }),
);

for (const [owner, file, specifier, publicBinding] of [
  [
    'verticals/catalog',
    'verticals/catalog/shared/domain/catalog-selection-purpose.ts',
    '@app/catalog/domain/catalog-selection-purpose',
    'selectSmallestCompleteCatalogSelectionBasis',
  ],
  [
    'packages/catalog-selection-contracts',
    'packages/catalog-selection-contracts/src/domain/catalog-unit-conversion-evidence.ts',
    '@app/catalog-selection-contracts/catalog-unit-conversion-evidence',
    'catalogUnitConversionProves',
  ],
] as const) {
  for (const privateSelection of [false, true]) {
    it.live(`checks actual published Catalog routine ${publicBinding} private=${privateSelection}`, () =>
      Effect.gen(function* actualPublishedCatalogRoutine() {
        const root = yield* makeActualCatalogSelectionFixture(file);
        const privateOrigin = `${owner}/src/handlers/private-contract.ts`;
        yield* write(root, privateOrigin, PRIVATE_ROUTINE_SOURCE);
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
          `import { ${binding} } from '${specifier}';\n`,
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
