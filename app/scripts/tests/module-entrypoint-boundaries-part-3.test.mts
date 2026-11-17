import { mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Cause, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  hasGeneratedActionClientPublication,
  hasOwnerLocalReadServiceFactory,
  ownerActionClientPublication,
  hasPublishedGeneratedContractShim,
} from '../generated-governed-http-boundary.mts';
import {
  hasGeneratedGovernedClientContract,
  hasGeneratedModuleApiReadContract,
} from '../generated-module-api-boundary.mts';
import {
  assertPublishedOutboxContractSource,
  resolvePublishedContractModuleId,
} from '../published-outbox-contracts.mts';
import {
  PARTY_VERTICAL_PATH,
  MARKET_DEPLOYMENT_ID,
  CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH,
  PRIVACY_VERTICAL_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_DEPENDENCY_VERSION,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  APP_PACKAGE_LINK_DIRECTORY,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  VERTICALS_WORKSPACE_DECLARATION,
  SHARED_CONTRACTS_WORKSPACE_NAME,
  SHARED_CONTRACTS_WORKSPACE_PATH,
  CATALOG_VERTICAL_PATH,
  PRICING_SHARED_API_PATH,
  PRICING_HANDLER_PATH,
  BOUNDARY_FIXTURE_TOPOLOGY,
  BOUNDARY_FIXTURE_SHELL_ID,
  BOUNDARY_FIXTURE_SHELL_PATH,
  BOUNDARY_FIXTURE_INVENTORY,
  IMPORTED_MODULE_KEY_PROPERTY,
  INVENTORY_DEPLOYMENT_ID,
  STOCK_LIST_CLIENT_CONTRACT_IMPORT,
  SCHEMA_DISPATCH_IMPORTS,
  RESERVE_CLIENT_RELATIVE_IMPORT,
  INVENTORY_MODULE_ID,
  UNUSED_NATIVE_API_DECLARATION,
  CORE_RUNTIME_SOURCE_IMPORT,
  EXPECTED_EFFECT_FAILURE,
  GOVERNED_SEARCH_HEADER,
  checkModuleEntrypointBoundaries,
  PROTECTED_AUTHORIZATION_SOURCE,
  STOCK_LIST_STEM,
  GATEWAY_CONTRACT_FILE,
  INVENTORY_CONTRACT_IMPORT,
  OPTIONS_CALL_TAIL,
  AUTHORIZATION_VALUE,
  AUTHORIZATION_VALUE_TAIL,
  CORRELATION_VALUE_TAIL,
  INVENTORY_API_PREFIX,
  DEFAULT_API_PREFIX,
  DEFAULT_API_PREFIX_TAIL,
  MODULE_API_KIND,
  MODULE_API_HEADER,
  ACTION_FILE,
  PARTY_API_CLIENT_EXPORT,
  PARTY_API_CLIENT_SPECIFIER,
  PARTY_CLIENT_SOURCE_PATH,
  PARTY_DEPLOYMENT_ID,
  PARTY_MODULE_ID,
  PARTY_OUTBOX_SPECIFIER,
  PARTY_PACKAGE_NAME,
  INVENTORY_VERTICAL_PATH,
  write,
  governedClientFixture,
  moduleReadFixture,
  assertRejectedSources,
  makeFixture,
  ENGAGEMENT_ACTION_DIRECTORY,
  ENGAGEMENT_ACTION_FILE,
  ENGAGEMENT_REJECTION,
  writeEngagementLifecycleFixture,
  EngagementInventorySchema,
  violations,
  partyPackage,
  partyClientSource,
  generatedPartyDetailClientSource,
  generatedPartyActionHttpClientSource,
  assertPublishedPartyUsage,
  partyManifestSource,
  partyOutboxSource,
  UNMOUNTED_ISSUER_ENDPOINT,
  UNRECOGNIZED_ISSUER_PATH,
  readPricingSourceTree,
  RESOLVED_OWNER_CONSUMER,
  RESOLVED_FOREIGN_HANDLER,
  RENAMED_CONTRACTS_PACKAGE,
  makeResolvedOwnerFixture,
  PORTAL_PUBLIC_SCHEMA,
  PORTAL_PUBLIC_CLIENT,
  PORTAL_SHELL_CONSUMER,
  makePortalPublicRoleFixture,
  makeActualPartyClientFixture,
  makeActualCustomerContextAggregateFixture,
} from './module-entrypoint-boundary-fixtures.mts';

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

it('rejects a ResourceRef import without the consuming TypeScript project reference', () => {
  expect(() => assertPublishedPartyUsage({ projectReferenceDeclared: false })).toThrow(
    /must project-reference @app\/party-registry/u,
  );
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

it('accepts the protected classification on a generated read and refuses any other kind', () => {
  const base = moduleReadFixture(STOCK_LIST_STEM, 'StockList', 'stockList');
  // O62: a protected read decides itself, so the generated descriptor names no legacy permission target.
  expect(base).not.toContain('permissionTarget');
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

it('resolves the published owner client once and requires exact relative Action exports', () => {
  const owner = INVENTORY_VERTICAL_PATH;
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

for (const privateSelection of [false, true]) {
  it.live(`checks actual Customer Context public aggregate private=${privateSelection}`, () =>
    Effect.gen(function* actualCustomerContextAggregate() {
      const root = yield* makeActualCustomerContextAggregateFixture();
      const apiFile = 'verticals/commerce-customer-context/shared/api.ts';
      const privateOrigin = CUSTOMER_CONTEXT_PRIVATE_CONTRACT_PATH;
      yield* write(root, privateOrigin, 'export const privateAggregateHandler = () => true;\n');
      if (privateSelection) {
        const source = yield* Effect.promise(() => readFile(path.join(root, apiFile), 'utf-8'));
        yield* write(
          root,
          apiFile,
          `${source}\nexport { privateAggregateHandler } from '../src/handlers/private-contract.ts';\n`,
        );
      }
      const binding = privateSelection ? 'privateAggregateHandler' : 'commerceCustomerContextApi';
      yield* write(
        root,
        'apps/shell-super-app/src/customer-context-aggregate-consumer.ts',
        `import { ${binding} } from '@app/commerce-customer-context/api';\n`,
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
