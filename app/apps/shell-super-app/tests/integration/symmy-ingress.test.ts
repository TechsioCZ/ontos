import { ActiveApplicationCompositionUnavailableError } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { moduleReleaseApiBaseUrl } from '@app/core-runtime/unit-service-fetch';
import {
  GatewayAuthenticationRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
} from '@app/shared-contracts';
import {
  decodeSymmyItemOutcome,
  SYMMY_FIXTURE_ROUTES,
  SYMMY_REST_PREFIX,
  SYMMY_ROUTES,
} from '@app/shared-contracts/symmy';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { dispatchEffectBffRequest, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Cause, Effect, Layer, Logger, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
} from '@app/price-group-catalog/api/client';
import { PriceGroupSourceAssociationsRequestSchema } from '@app/price-group-catalog/apis/price-group-source-associations';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { AdmitSymmyJobPayloadSchema } from '@app/symmy-integration/api/admit-symmy-job-action';
import { assert, expect, it } from 'effect-rstest';

import { SymmyIngressAuthenticationLive, SymmyIngressDefectLive } from '../../api/index.ts';
import {
  SymmyFixtureJobIdSchema,
  symmyFixtureJobNotFoundProblem,
  symmyUnavailableProblem,
} from '../../api/symmy/contract.ts';
import { forwardSymmyOwnerRelease, makeSymmyGovernedDispatch } from '../../api/symmy/governed-dispatch.ts';
import {
  SymmyHostMountLive,
  SymmyIngress,
  SymmyIngressHandlersLive,
  SymmyIngressTransportLive,
  SymmyIngressSchemaErrorLive,
} from '../../api/symmy/transport.ts';
import type { SymmyIngressAdmission, SymmyIngressRequest } from '../../api/symmy/transport.ts';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { SymmyPriceListsResponseSchema } from '../../api/symmy/price-lists-public-contract.ts';
import {
  SymmyInternalCustomersProjectionSchema,
  SymmyInternalPriceListsProjectionSchema,
  SymmyInternalProductsProjectionSchema,
} from '../../api/symmy/read-projection-contracts.ts';
import { SymmyInternalRegionsProjectionSchema } from '../../api/symmy/regions-projection-contract.ts';

const host = 'https://shell.example.test';
const shellPrefix = '/shell-super-app-api';
const fixtureId = 'internal-c14-fixture';
const groupCode = 'fixture-group';
const jobId = '10000000-0000-4000-8000-000000000001';
const regionsMarketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.market-catalog.market',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const regionsProjection = Schema.decodeUnknownSync(SymmyInternalRegionsProjectionSchema)({
  contractVersion: 'INTERNAL_C14',
  count: 2,
  limit: 50,
  offset: 0,
  projection: 'regions',
  regions: [
    {
      country_codes: ['CZ'],
      currency_code: 'CZK',
      id: `~c14r1.${'a'.repeat(43)}`,
      market_code: 'CZ_NATIVE',
      marketRef: regionsMarketRef,
      source_record_id: 'source-region-a',
    },
  ],
  unsupported_fields: ['name', 'tax_rate', 'tax_included', 'payment_providers'],
});
const priceListsProjection = Schema.decodeUnknownSync(SymmyInternalPriceListsProjectionSchema)({
  contractVersion: 'INTERNAL_C14',
  count: 1,
  limit: 50,
  offset: 0,
  price_lists: [
    {
      description: 'Wholesale prices',
      id: `~c14s1.${'a'.repeat(43)}.${regionsMarketRef.resourceId}`,
      name: 'CZ wholesale',
      priceGroupRef: {
        moduleId: 'pricing.price-group-catalog',
        resourceId: regionsMarketRef.resourceId,
        resourceType: 'pricing.price-group-catalog.price-group',
        tenantId: regionsMarketRef.tenantId,
      },
      source_record_id: 'CZ wholesale',
      starts_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  projection: 'price_lists',
  unsupported_fields: ['prices'],
});
const publicPriceListsBody = {
  count: 1,
  limit: 50,
  offset: 0,
  priceLists: [
    {
      code: 'CZ wholesale',
      description: 'Wholesale prices',
      name: 'CZ wholesale',
      priceGroupRef: {
        moduleId: 'pricing.price-group-catalog',
        resourceId: regionsMarketRef.resourceId,
        resourceType: 'pricing.price-group-catalog.price-group',
        tenantId: regionsMarketRef.tenantId,
      },
      startsAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};
const productsRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId: regionsMarketRef.tenantId,
} as const;
const productsVariantId = '44444444-4444-4444-8444-444444444444';
const productsNative = {
  catalogReady: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lifecycle: 'DRAFT',
  name: 'Native chair',
  productRef: productsRef,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  variants: [
    {
      lifecycle: 'WORK_IN_PROGRESS',
      productRef: productsRef,
      variantId: productsVariantId,
      variantRef: {
        moduleId: 'commerce.catalog',
        resourceId: productsVariantId,
        resourceType: 'commerce.catalog.variant',
        tenantId: regionsMarketRef.tenantId,
      },
    },
  ],
} as const;
const productsProjection = Schema.decodeUnknownSync(SymmyInternalProductsProjectionSchema)({
  contractVersion: 'INTERNAL_C14',
  count: 2,
  limit: 50,
  offset: 0,
  products: [
    {
      id: `~c14r1.${'p'.repeat(43)}`,
      product: productsNative,
      source_record_id: 'source-product-a',
      variantSources: [
        { id: `~c14r1.${'v'.repeat(43)}`, source_record_id: 'source-variant-a', variantId: productsVariantId },
      ],
    },
  ],
  projection: 'products',
  unsupported_fields: ['tax', 'assortment', 'prices', 'stock'],
});
const publicProductsReadBody = {
  count: 2,
  limit: 50,
  offset: 0,
  products: [
    {
      id: `~c14r1.${'p'.repeat(43)}`,
      product: productsNative,
      sourceRecordId: 'source-product-a',
      variantSources: [
        { id: `~c14r1.${'v'.repeat(43)}`, sourceRecordId: 'source-variant-a', variantId: productsVariantId },
      ],
    },
  ],
};
const customersTenantId = regionsMarketRef.tenantId;
const customersPartyRef = {
  moduleId: 'party.registry',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'party.registry.party',
  tenantId: customersTenantId,
} as const;
const customersProfile = {
  profileRef: {
    kind: 'RETAIL',
    moduleId: 'commerce.customer-context',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId: customersTenantId,
  },
  revision: 1,
  state: 'ACTIVE',
  subject: {
    kind: 'RETAIL',
    partyRef: customersPartyRef,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'core.identity.legal-entity',
      tenantId: customersTenantId,
    },
  },
} as const;
const customersProjection = Schema.decodeUnknownSync(SymmyInternalCustomersProjectionSchema)({
  contractVersion: 'INTERNAL_C14',
  count: 2,
  customers: [
    {
      ico: { _tag: 'ABSENT' },
      id: `~c14r1.${'c'.repeat(43)}`,
      partyRef: customersPartyRef,
      profile: customersProfile,
      source_record_id: 'source-customer-a',
    },
  ],
  limit: 50,
  offset: 0,
  projection: 'customers',
  unsupported_fields: ['addresses', 'groups', 'name', 'contacts'],
});
const publicCustomersReadBody = {
  count: 2,
  customers: [
    {
      ico: { _tag: 'ABSENT' },
      id: `~c14r1.${'c'.repeat(43)}`,
      partyRef: customersPartyRef,
      profile: customersProfile,
      sourceRecordId: 'source-customer-a',
    },
  ],
  limit: 50,
  offset: 0,
};
const readFixture = (route: string, references: readonly string[]) => {
  if (route === 'adminCustomers') {
    return customersProjection;
  }
  if (route === 'adminRegions') {
    return regionsProjection;
  }
  if (route === 'adminProducts') {
    return productsProjection;
  }
  return route === 'priceLists' ? priceListsProjection : references;
};
const publicRegionsBody = {
  count: 2,
  limit: 50,
  offset: 0,
  regions: [
    {
      countryCodes: ['CZ'],
      currencyCode: 'CZK',
      id: `~c14r1.${'a'.repeat(43)}`,
      marketCode: 'CZ_NATIVE',
      marketRef: regionsMarketRef,
      sourceRecordId: 'source-region-a',
    },
  ],
};
const publicReadBody = (path: string, references: readonly string[]) => {
  if (path === SYMMY_ROUTES.adminCustomers.path) {
    return publicCustomersReadBody;
  }
  if (path === SYMMY_ROUTES.adminRegions.path) {
    return publicRegionsBody;
  }
  if (path === SYMMY_ROUTES.adminProducts.path) {
    return publicProductsReadBody;
  }
  return path === SYMMY_ROUTES.priceLists.path ? publicPriceListsBody : { references };
};
const idempotencyKey = 'fixture-job-attempt';
const validKey = 'fedcba9876543210fedcba9876543210';
const wrongKindKey = 'synthetic-other-kind-key';
const rateLimitedKey = 'synthetic-rate-limited-key';
const unavailableKey = 'synthetic-unavailable-key';
const revision = 'fixture-approved-revision';
const apiBaseUrl = moduleReleaseApiBaseUrl('symmy-integration', 'fixture-build');
const releasePath = '/module-api/symmy-integration/fixture-build/symmy-integration-api';

const invalid = GatewayAuthenticationRequiredProblemSchema.make({
  detail: 'A valid API key is required.',
  status: 401,
  title: 'Gateway authentication required',
  type: 'https://ontos.dev/problems/gateway-authentication-required',
});
const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The authenticated principal cannot use the requested gateway context.',
  status: 403,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});
const rateLimited = GatewayRateLimitedProblemSchema.make({
  detail: 'Too many gateway requests.',
  retryAfterSeconds: 30,
  status: 429,
  title: 'Gateway rate limited',
  type: 'https://ontos.dev/problems/gateway-rate-limited',
});

const fixtureApi = HttpApi.make(ShellAuthenticationApi.identifier)
  .add(ShellAuthenticationApi.groups.symmy)
  .add(
    HttpApiGroup.make('normalShell').add(
      HttpApiEndpoint.post('auth', '/auth/api-key/gateway-context', {
        success: Schema.Struct({ ok: Schema.Literal(true) }),
      }),
      HttpApiEndpoint.get('session', '/auth/session', {
        success: Schema.Struct({ ok: Schema.Literal(true) }),
      }),
    ),
  );

const start = ({
  acquireOwnerAssertion,
  acquireRouteAssertion,
  defect,
  dispatch,
  enableBatch = false,
  observe,
  ownerFetch = globalThis.fetch,
}: {
  readonly acquireOwnerAssertion?: NonNullable<SymmyIngressAdmission['acquireOwnerAssertion']>;
  readonly acquireRouteAssertion?: NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>;
  readonly defect?: Cause.Cause<never>;
  readonly dispatch?: typeof SymmyIngress.Service.dispatch;
  readonly enableBatch?: boolean;
  readonly observe?: (request: SymmyIngressRequest) => void;
  readonly ownerFetch?: typeof fetch;
} = {}) => {
  const authAttempts: string[] = [];
  const admissionRoutes: string[] = [];
  const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
  const logger = Logger.layer([
    Logger.make((options) => {
      logs.push(Logger.formatStructured.log(options));
    }),
  ]);
  let shellCalls = 0;
  let assertions = 0;
  const observeFixture = <Result, Problem>(
    input: { readonly admission: SymmyIngressAdmission; readonly request: SymmyIngressRequest },
    result: Effect.Effect<Result, Problem> | undefined,
  ) =>
    Effect.gen(function* observeFixtureDispatch() {
      const { admission, request } = input;
      expect(admission.compositionRevision).toBe(revision);
      expect(Redacted.value(admission.assertion)).toBe(`synthetic-assertion-${assertions}`);
      expect(admission).not.toHaveProperty('rawKey');
      observe?.(request);
      if (defect !== undefined) {
        return yield* Effect.failCause(defect);
      }
      return yield* result ?? Effect.fail(symmyUnavailableProblem);
    });
  const ingress = Layer.succeed(SymmyIngress, {
    admit: (key, _request, route) =>
      Effect.gen(function* authorizeFixture() {
        authAttempts.push(key);
        admissionRoutes.push(route);
        if (key === wrongKindKey) {
          return yield* Effect.fail(forbidden);
        }
        if (key === rateLimitedKey) {
          return yield* Effect.fail(rateLimited);
        }
        if (key === unavailableKey) {
          return yield* Effect.fail(symmyUnavailableProblem);
        }
        if (key !== validKey) {
          return yield* Effect.fail(invalid);
        }
        assertions += 1;
        const admission = {
          apiBaseUrl,
          assertion: Redacted.make(`synthetic-assertion-${assertions}`),
          compositionRevision: revision,
        };
        const withOwner = acquireOwnerAssertion === undefined ? admission : { ...admission, acquireOwnerAssertion };
        return acquireRouteAssertion === undefined ? withOwner : { ...withOwner, acquireRouteAssertion };
      }),
    dispatch: {
      apply: (input) => observeFixture(input, dispatch?.apply(input)),
      poll: (input) => observeFixture(input, dispatch?.poll(input)),
      read: (input) => observeFixture(input, dispatch?.read(input)),
      submit: (input) => observeFixture(input, dispatch?.submit(input)),
    },
  });
  const symmy = SymmyIngressHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        SymmyIngressAuthenticationLive.pipe(Layer.provideMerge(ingress)),
        SymmyIngressSchemaErrorLive,
        SymmyIngressDefectLive,
        logger,
        Layer.succeed(FetchHttpClient.Fetch, ownerFetch),
      ),
    ),
  );
  const normalShellResponse = Effect.sync(() => {
    shellCalls += 1;
    return { ok: true } as const;
  });
  const normalShell = HttpApiBuilder.group(fixtureApi, 'normalShell', (group) =>
    group.handle('auth', () => normalShellResponse).handle('session', () => normalShellResponse),
  );
  const runtime = assembleEffectBffRuntime({
    api: fixtureApi,
    handlers: Layer.mergeAll(normalShell, symmy),
    transport: SymmyIngressTransportLive.pipe(Layer.provide(SymmyHostMountLive)),
  }).createHandler({
    dataPlatform: { batch: { enabled: enableBatch }, enabled: enableBatch },
    openapi: { path: '/openapi.json' },
  });
  return {
    admissionRoutes,
    assertions: () => assertions,
    authAttempts,
    dispose: runtime.dispose,
    logs,
    request: (path: string, init: RequestInit, prefix = SYMMY_REST_PREFIX) =>
      dispatchEffectBffRequest((request) => runtime.handler(request), new Request(host + path, init), { prefix }),
    shellCalls: () => shellCalls,
  };
};

const fixtureJson = { body: '{"fixtureId":"internal-c14-fixture"}', headers: { 'content-type': 'application/json' } };
const stockUnitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId: regionsMarketRef.tenantId,
};
const stockRow = (itemKey: string, observedAt = '2026-01-01T10:00:00Z') => ({
  businessObservedAt: observedAt,
  itemKey,
  locationKey: 'warehouse-1',
  quantity: { amount: '12.5', unitRef: stockUnitRef },
  revision: 'r1',
  sourceReference: `erp-${itemKey}`,
});
/** The decoder reads any ISO instant, the owner admission always receives the canonical form. */
const stockBatchJson = (rows: readonly ReturnType<typeof stockRow>[]) => ({
  body: JSON.stringify({ stock: rows }),
  headers: { 'content-type': 'application/json' },
});

const priceProductRef = { ...stockUnitRef, resourceType: 'commerce.catalog.product' };
const priceVariantRef = {
  ...stockUnitRef,
  resourceId: '33333333-3333-4333-8333-333333333334',
  resourceType: 'commerce.catalog.variant',
};
const priceRow = {
  amount: '25.50',
  commercialScope: { channelId: 'B2B', marketId: 'cz-market' },
  currencyCode: 'CZK',
  effectiveFrom: '2026-01-01T00:00:00Z',
  productRef: priceProductRef,
  unitBasis: { quantity: '1', unitRef: stockUnitRef },
  variantRef: priceVariantRef,
};
const priceListRow = {
  businessCode: 'CZ_WHOLESALE',
  code: 'cz-wholesale',
  description: 'Wholesale prices',
  effectiveFrom: '2026-01-01T00:00:00Z',
  name: 'CZ wholesale',
  prices: [priceRow],
  purpose: 'Wholesale customers',
};
/** The decoder reads any ISO instant, the owner admission always receives the canonical form. */
const priceListsBatchJson = (priceLists: readonly (typeof priceListRow)[]) => ({
  body: JSON.stringify({ priceLists }),
  headers: { 'content-type': 'application/json' },
});
const canonicalPriceList = {
  ...priceListRow,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  prices: [{ ...priceRow, effectiveFrom: '2026-01-01T00:00:00.000Z' }],
};

type SymmyIngressServer = ReturnType<typeof start>;
interface PublicPriceGroupRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const definedAt = '2026-01-01T00:00:00.000Z';
const definePriceRow = { ...priceRow, operation: 'DEFINE' };
const revisePriceRow = {
  amount: '30',
  currencyCode: 'CZK',
  expectedRevision: { revision: 1, revisionId: '44444444-4444-4444-8444-444444444444' },
  operation: 'REVISE',
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: '33333333-3333-4333-8333-333333333340',
    resourceType: 'commerce.pricing.price',
    tenantId: regionsMarketRef.tenantId,
  },
};
const priceGroupRefOfBatch = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: '60000000-0000-4000-8000-000000000001',
};
const priceBatchJson = (prices: readonly unknown[]) => ({
  body: JSON.stringify({ priceGroupRef: priceGroupRefOfBatch, prices }),
  headers: { 'content-type': 'application/json' },
});

/** The public products body, and the rows the owner admission receives for it. */
const publicProduct = {
  identifier: { type: 'sku', value: 'SKU-1' },
  name: 'Public source product',
  variants: [
    {
      identifier: { type: 'sku', value: 'SKU-1-A' },
      localized: [{ locale: 'en', name: 'Variant name' }],
      prices: [{ amount: '10.5', currencyCode: 'CZK' }],
    },
  ],
};
const publicProductsBody = { products: [publicProduct] };
const publicProductRows = [
  {
    identifier: { type: 'sku', value: 'SKU-1' },
    name: 'Public source product',
    unsupported: [],
    variants: [
      {
        identifier: { type: 'sku', value: 'SKU-1-A' },
        localized: [{ locale: 'en', name: 'Variant name' }],
        prices: [{ amount: '10.5', currencyCode: 'CZK' }],
      },
    ],
  },
];

const publicCustomersBody = {
  customers: [
    { customerId: 'customer-1', firstName: ' Jana ', kind: 'PERSON', lastName: 'Nováková' },
    {
      addresses: [
        {
          label: 'Sídlo',
          postalAddress: { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' },
          purposes: ['BILLING'],
        },
      ],
      businessName: 'Firma s.r.o.',
      contacts: [{ preferred: true, type: 'EMAIL', value: 'office@example.test' }],
      customerId: 'customer-2',
      kind: 'ORGANIZATION',
      officialIdentifiers: [
        { type: 'ICO', value: '00000019' },
        { type: 'CZ_DIC', value: 'CZ00000019' },
      ],
    },
  ],
} satisfies Schema.Json;
const publicCustomerRows = [
  {
    addresses: [],
    contacts: [],
    customerId: 'customer-1',
    firstName: 'Jana',
    kind: 'PERSON',
    lastName: 'Nováková',
    officialIdentifiers: [],
  },
  {
    addresses: [
      {
        label: 'Sídlo',
        postalAddress: { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' },
        purposes: ['BILLING'],
      },
    ],
    businessName: 'Firma s.r.o.',
    contacts: [{ preferred: true, type: 'EMAIL', value: 'office@example.test' }],
    customerId: 'customer-2',
    kind: 'ORGANIZATION',
    officialIdentifiers: [
      { identifierType: 'ICO', value: '00000019' },
      { identifierType: 'CZ_DIC', value: 'CZ00000019' },
    ],
  },
];
const customersJson = (body: Schema.Json = publicCustomersBody) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

const texts = (count: number) => Array.from({ length: count }, (_, index) => ({ locale: `l${index}`, name: 'N' }));
const productsJson = (body: Schema.Json = publicProductsBody) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

/** The body each durable or synchronous POST route accepts: the public body, or an operator fixture identity. */
const routeBody = (path: string) => {
  if (path === SYMMY_ROUTES.inventoryStockBatch.path) {
    return stockBatchJson([stockRow('item-1'), stockRow('item-2')]);
  }
  if (path === SYMMY_ROUTES.priceListPricesBatch.path) {
    return priceBatchJson([definePriceRow, revisePriceRow]);
  }
  if (path === SYMMY_ROUTES.productsBatch.path) {
    return productsJson();
  }
  if (path === SYMMY_ROUTES.customersBatch.path) {
    return customersJson();
  }
  return path === SYMMY_ROUTES.priceListsBatchUpsert.path ? priceListsBatchJson([priceListRow]) : fixtureJson;
};

const internalProductInput = {
  contractVersion: 'INTERNAL_C14',
  plan: {
    items: [
      {
        effects: [
          {
            effectKey: 'create-product',
            intent: { _tag: 'CatalogCreateProduct', payload: { name: 'Internal source product' } },
            operation: {
              entrypointKey: 'commerce.catalog.create-product',
              moduleId: 'commerce.catalog',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'product-record',
        source: {
          entityKind: 'PRODUCT',
          issuerId: 'internal-issuer',
          sourceNamespace: 'internal-products',
          sourceRecordId: 'opaque-source-product',
        },
        sourceOccurrenceId: 'internal-product-occurrence',
      },
    ],
  },
} as const;

it.effect('accepts the public products body and forwards the rows with their identity and no contract version', () =>
  Effect.gen(function* versionedBusinessRequest() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = yield* Schema.decodeUnknownEffect(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        ...productsJson(),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(yield* Effect.promise(() => response.json())).toEqual({ jobId, status: 'queued' });
    expect(forwarded).toEqual([{ idempotencyKey, products: publicProductRows, route: 'productsBatch' }]);
  }),
);

it.effect('rejects the internal plan, authority overrides and credentials nested in the public products', () =>
  Effect.gen(function* publicProductBoundaries() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (payload: Schema.Json, query = '') =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.productsBatch.path}${query}`, {
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const product = publicProduct;
    expect((yield* submit(internalProductInput)).status).toBe(400);
    expect((yield* submit({ fixtureId: 'internal-c14-fixture' })).status).toBe(400);
    expect((yield* submit({ ...publicProductsBody, contractVersion: 'INTERNAL_C14' })).status).toBe(400);
    expect((yield* submit({ ...publicProductsBody, tenantId: '90000000-0000-4000-8000-000000000001' })).status).toBe(
      400,
    );
    expect((yield* submit({ products: [{ ...product, prices: [{ amount: '1', currencyCode: 'CZK' }] }] })).status).toBe(
      400,
    );
    expect((yield* submit({ products: [{ ...product, unknownField: true }] })).status).toBe(400);
    expect((yield* submit({ products: [{ identifier: product.identifier, variants: product.variants }] })).status).toBe(
      400,
    );
    expect((yield* submit({ products: [{ ...product, variants: [] }] })).status).toBe(400);
    expect((yield* submit({ products: [] })).status).toBe(400);
    expect(
      (yield* submit({ products: Array.from({ length: 17 }, () => ({ name: 'P', variants: [{}] })) })).status,
    ).toBe(400);
    expect((yield* submit(publicProductsBody, '?contractVersion=INTERNAL_C14')).status).toBe(400);
    const reflected = yield* submit({ products: [{ ...product, name: `Private ${validKey}` }] });
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(server.authAttempts).toEqual(Array.from({ length: 12 }, () => validKey));
  }),
);

it.effect(
  'refuses a product that needs more than thirty-two effects or a request that needs more than sixteen items',
  () =>
    Effect.gen(function* planLimits() {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => start()),
        (fixture) => Effect.promise(fixture.dispose),
      );
      const submit = (payload: Schema.Json) =>
        Effect.promise(() =>
          server.request(SYMMY_ROUTES.productsBatch.path, {
            body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
            method: 'POST',
          }),
        );
      expect((yield* submit({ products: [{ name: 'P', variants: [{ localized: texts(33) }] }] })).status).toBe(400);
      const priced = { name: 'P', variants: [{ prices: [{ amount: '1', currencyCode: 'CZK' }] }] };
      expect((yield* submit({ products: Array.from({ length: 9 }, () => priced) })).status).toBe(400);
      expect(server.authAttempts).toEqual([validKey, validKey]);
    }),
);

/** A server whose dispatch admits every request, so a body that passes the decoder answers 202. */
const acceptingServer = () =>
  Effect.gen(function* acceptingServerFixture() {
    const admittedJobId = yield* Schema.decodeUnknownEffect(SymmyFixtureJobIdSchema)(jobId);
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
  });

it.effect('accepts the public customers body and forwards the rows with their identity and no contract version', () =>
  Effect.gen(function* publicCustomers() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = yield* Schema.decodeUnknownEffect(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customersBatch.path, {
        ...customersJson(),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(yield* Effect.promise(() => response.json())).toEqual({ jobId, status: 'queued' });
    expect(forwarded).toEqual([{ customers: publicCustomerRows, idempotencyKey, route: 'customersBatch' }]);
  }),
);

it.effect('rejects the internal plan, groups, metadata and credentials nested in the public customers', () =>
  Effect.gen(function* publicCustomerBoundaries() {
    const server = yield* acceptingServer();
    const submit = (payload: Schema.Json, query = '', headers: Record<string, string> = {}) =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.customersBatch.path}${query}`, {
          body: JSON.stringify(payload),
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            'x-api-key': validKey,
            ...headers,
          },
          method: 'POST',
        }),
      );
    const person = { customerId: 'c-1', firstName: 'Jana', kind: 'PERSON', lastName: 'Nováková' };
    const organization = { businessName: 'Firma', customerId: 'c-2', kind: 'ORGANIZATION' };
    const postalAddress = { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' };
    const address = { postalAddress, purposes: ['BILLING'] };
    expect((yield* submit(publicCustomersBody)).status).toBe(202);
    expect((yield* submit(internalProductInput)).status).toBe(400);
    expect((yield* submit({ fixtureId: 'internal-c14-fixture' })).status).toBe(400);
    expect((yield* submit({ ...publicCustomersBody, contractVersion: 'INTERNAL_C14' })).status).toBe(400);
    expect((yield* submit({ ...publicCustomersBody, tenantId: '90000000-0000-4000-8000-000000000001' })).status).toBe(
      400,
    );
    expect((yield* submit({ customers: [{ ...person, customerGroupCodes: ['g'] }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ ...person, metadata: {} }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ ...person, contractVersion: 'INTERNAL_C14' }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ ...person, unknownField: true }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ customerId: 'c-1', kind: 'PERSON', lastName: 'N' }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ ...person, businessName: 'Firma' }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ ...organization, firstName: 'Jana' }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ customerId: 'c-1', kind: 'ORGANIZATION' }] })).status).toBe(400);
    expect((yield* submit({ customers: [{ firstName: 'Jana', kind: 'PERSON', lastName: 'N' }] })).status).toBe(400);
    expect(
      (yield* submit({ customers: [{ ...person, officialIdentifiers: [{ type: 'ICO', value: '00000018' }] }] })).status,
    ).toBe(400);
    expect(
      (yield* submit({
        customers: [{ ...person, contacts: [{ preferred: false, type: 'PHONE', value: '123456789' }] }],
      })).status,
    ).toBe(400);
    expect(
      (yield* submit({
        customers: [{ ...organization, addresses: [{ ...address, postalAddress: { city: 'Praha' } }] }],
      })).status,
    ).toBe(400);
    expect((yield* submit({ customers: [] })).status).toBe(400);
    expect((yield* submit({})).status).toBe(400);
    expect((yield* submit({ customers: Array.from({ length: 17 }, () => person) })).status).toBe(400);
    expect(
      (yield* submit({
        customers: [
          {
            ...organization,
            contacts: Array.from({ length: 11 }, () => ({ preferred: false, type: 'EMAIL', value: 'a@b.cz' })),
          },
        ],
      })).status,
    ).toBe(400);
    expect(
      (yield* submit({ customers: [{ ...organization, addresses: Array.from({ length: 11 }, () => address) }] }))
        .status,
    ).toBe(400);
    expect((yield* submit(publicCustomersBody, '?contractVersion=INTERNAL_C14')).status).toBe(400);
    expect((yield* submit(publicCustomersBody, '', { 'idempotency-key': 'not valid!' })).status).toBe(400);
    const reflected = yield* submit({ customers: [{ ...person, firstName: `Private ${validKey}` }] });
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
  }),
);

it.effect('refuses a customers request whose customers and addresses need more than sixteen plan items', () =>
  Effect.gen(function* customerPlanLimits() {
    const server = yield* acceptingServer();
    const submit = (payload: Schema.Json) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.customersBatch.path, {
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const address = {
      postalAddress: { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' },
      purposes: ['BILLING'],
    };
    const withAddresses = (count: number) => ({
      addresses: Array.from({ length: count }, () => address),
      customerId: 'c-1',
      firstName: 'Jana',
      kind: 'PERSON',
      lastName: 'Nováková',
    });
    expect((yield* submit({ customers: [withAddresses(10), withAddresses(4)] })).status).toBe(202);
    expect((yield* submit({ customers: [withAddresses(10), withAddresses(5)] })).status).toBe(400);
  }),
);

it.effect('requires a replay key for versioned synchronous writes before any owner dispatch', () =>
  Effect.gen(function* synchronousReplayIdentity() {
    let calls = 0;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          observe: () => {
            calls += 1;
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customerGroupsBatch.path, {
        body: JSON.stringify(internalProductInput),
        headers: { 'content-type': 'application/json', 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(428);
    expect(yield* Effect.promise(() => response.json())).not.toHaveProperty('jobId');
    expect(calls).toBe(0);
  }),
);

const internalRoute = {
  allowedOwnerOperations: [
    {
      entrypointKey: 'commerce.catalog.api.catalog-source-product-page',
      moduleId: 'commerce.catalog',
      schemaVersion: '1',
    },
  ],
  issuerId: 'internal-issuer',
  legalEntityId: '80000000-0000-4000-8000-000000000001',
  mappingVersion: 'internal-map-v1',
  routeId: '70000000-0000-4000-8000-000000000001',
  routeRevision: 'internal-route-v1',
  sourceEntityKind: 'PRODUCT',
  sourceMappingVersion: 'internal-map-v1',
  sourceNamespace: 'internal-products',
  sourceRouteId: '70000000-0000-4000-8000-000000000001',
  sourceRouteRevision: 'internal-route-v1',
  tenantId: '60000000-0000-4000-8000-000000000001',
};

const nativePriceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: internalRoute.tenantId,
} as const;
const nativeCustomerGroupRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '50000000-0000-4000-8000-000000000011',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId: internalRoute.tenantId,
} as const;
const nativeGroupDefinition = (observedAt: string) => {
  const at = '1970-01-01T00:00:00.000Z';
  const period = { effectiveFrom: at, effectiveTo: null };
  const provenance = {
    actionInvocationId: '50000000-0000-4000-8000-000000000002',
    actorPrincipalId: '50000000-0000-4000-8000-000000000003',
    reason: 'Internal native owner fixture',
    trustedAt: at,
  };
  const definitionRevisionId = '50000000-0000-4000-8000-000000000004';
  const meaningFingerprint = 'b'.repeat(64);
  const result = Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)({
    currentEvidence: {
      catalogRevision: 1,
      definitionEffectivePeriod: period,
      definitionRevisionId,
      definitionRevisionNumber: 1,
      meaningFingerprint,
      observedAt,
      priceGroupRef: nativePriceGroupRef,
    },
    definition: {
      acceptedCatalogRevision: 1,
      classificationPurpose: 'Explicit source group classification',
      compatibilityContracts: [{ contractId: 'symmy.internal.fixture', version: 1 }],
      created: provenance,
      definitionRevisionId,
      description: 'Native description',
      displayName: 'Native source group',
      effectivePeriod: period,
      meaningFingerprint,
      previousDefinitionRevisionId: null,
      priceGroupRef: nativePriceGroupRef,
      revisionNumber: 1,
      semanticContinuity: null,
    },
    identity: {
      businessCode: 'PG_INTERNAL',
      created: provenance,
      createdAtCatalogRevision: 1,
      lifecycle: { activeFrom: at, retiredAt: null, state: 'ACTIVE' },
      meaningFingerprint,
      priceGroupRef: nativePriceGroupRef,
    },
    observedAt,
    selection: 'CURRENT',
  });
  return Schema.encodeSync(PriceGroupDefinitionResponseSchema)(result);
};

it.effect('uses a privately acquired route assertion without falling back to human Legal Entity selection', () =>
  Effect.gen(function* sealedRouteIssuerCapability() {
    const rawCode = 'CZ wholesale';
    const source = {
      entityKind: 'CUSTOMER_GROUP',
      issuerId: internalRoute.issuerId,
      route: { integrationRouteId: internalRoute.sourceRouteId, tenantId: internalRoute.tenantId },
      sourceNamespace: 'source-customer-group-namespace',
      sourceRecordId: rawCode,
    };
    const route = yield* Schema.decodeUnknownEffect(SymmyRouteContextResponseSchema)({
      ...internalRoute,
      resolvedCode: rawCode,
      selector: { kind: 'CUSTOMER_GROUP', source, target: nativeCustomerGroupRef },
      sourceNamespace: 'distinct-price-row-namespace',
    });
    const code = encodeSymmySourceSelector(
      {
        issuerId: source.issuerId,
        routeId: source.route.integrationRouteId,
        selectorKind: 'CUSTOMER_GROUP',
        sourceNamespace: source.sourceNamespace,
        tenantId: source.route.tenantId,
      },
      rawCode,
      nativeCustomerGroupRef.resourceId,
    );
    const scopes: Parameters<NonNullable<SymmyIngressAdmission['acquireRouteAssertion']>>[0][] = [];
    const nativeCalls: string[] = [];
    let genericSelections = 0;
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      nativeCalls.push(new URL(request.url).pathname);
      expect(request.headers.get('authorization')).toBe('Bearer sealed-sle-assertion');
      expect(Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(await request.json()).code).toBe(rawCode);
      return Response.json({ jobId, phase: 'admitted' });
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () => {
            genericSelections += 1;
            return Effect.fail(forbidden);
          },
          acquireRouteAssertion: (input) =>
            Effect.sync(() => {
              scopes.push(input);
              return {
                apiBaseUrl,
                assertion: Redacted.make('sealed-sle-assertion'),
                compositionRevision: revision,
                route,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('sealed-route-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customerGroupCustomersBatch.path.replace('{code}', code), {
        ...fixtureJson,
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(scopes).toEqual([{ code, replayIdempotencyKey: idempotencyKey, routeKey: 'customerGroupCustomersBatch' }]);
    expect(genericSelections).toBe(0);
    expect(nativeCalls).toEqual([`${releasePath}/symmy-integration/actions/admit-symmy-job`]);
  }),
);

const priceBatchRoute = (logicalRouteId: string, namespace: string) => ({
  ...internalRoute,
  allowedOwnerOperations: [
    {
      entrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
      moduleId: 'pricing.price-group-catalog',
      schemaVersion: '1',
    },
  ],
  routeId: '72000000-0000-4000-8000-000000000001',
  sourceEntityKind: 'PRICE',
  sourceNamespace: namespace,
  sourceRouteId: logicalRouteId,
});

it.effect(
  'copies the priceGroupRef of GET Price Lists into POST Price Batch and refuses every other list with one answer',
  () =>
    Effect.gen(function* priceGroupRefRoundTrip() {
      let sequence = 0;
      for (const sourceRecordId of ['CZ wholesale', 'CZ/wholesale', 'Žluťoučký / 価格', 'x'.repeat(300)]) {
        sequence += 1;
        const logicalRouteId = '71000000-0000-4000-8000-000000000001';
        const priceGroupNamespace = 'internal-price-groups';
        const listRoute = {
          ...priceBatchRoute(logicalRouteId, priceGroupNamespace),
          allowedOwnerOperations: [
            ...priceBatchRoute(logicalRouteId, priceGroupNamespace).allowedOwnerOperations,
            {
              entrypointKey: 'pricing.price-group-catalog.api.price-group-definition',
              moduleId: 'pricing.price-group-catalog',
              schemaVersion: '1',
            },
          ],
          sourceEntityKind: 'PRICE_LIST',
        };
        const admitted: (typeof AdmitSymmyJobPayloadSchema.Type)[] = [];
        const associationPages: { readonly issuer: string; readonly offset: number }[] = [];
        const ownerFetchFor =
          (issuerId: string): typeof fetch =>
          async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (path.endsWith('/reads/symmy-route-context')) {
              const payload = Schema.decodeUnknownSync(SymmyRouteContextRequestSchema)(await request.json());
              expect(payload.code).toBeUndefined();
              return Response.json(
                payload.routeKey === 'priceLists'
                  ? { ...listRoute, issuerId }
                  : { ...priceBatchRoute(logicalRouteId, priceGroupNamespace), issuerId },
              );
            }
            if (path.endsWith('/reads/price-group-source-associations')) {
              const payload = Schema.decodeUnknownSync(PriceGroupSourceAssociationsRequestSchema)(await request.json());
              expect(payload.routeId).toBe(logicalRouteId);
              expect(payload.namespace).toBe(priceGroupNamespace);
              associationPages.push({ issuer: payload.issuer, offset: payload.offset });
              // Only the issuer that created the list holds an association for it.
              const created = payload.issuer === internalRoute.issuerId;
              return Response.json({
                associations: created
                  ? [
                      {
                        priceGroupRef: nativePriceGroupRef,
                        sourceCorrelation: {
                          issuer: issuerId,
                          mappingVersion: internalRoute.sourceMappingVersion,
                          namespace: priceGroupNamespace,
                          recordKey: sourceRecordId,
                          routeId: logicalRouteId,
                        },
                      },
                    ]
                  : [],
                count: created ? 1 : 0,
                limit: payload.limit,
                offset: payload.offset,
              });
            }
            if (path.endsWith('/reads/price-group-definition')) {
              const payload = Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)(await request.json());
              return Response.json(nativeGroupDefinition(payload.trustedOperationAt));
            }
            admitted.push(Schema.decodeUnknownSync(AdmitSymmyJobPayloadSchema)(await request.json()));
            return Response.json({ jobId, phase: 'admitted' });
          };
        const startIssuer = (issuerId: string) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              start({
                acquireOwnerAssertion: ({ audience }) =>
                  Effect.succeed({
                    apiBaseUrl: moduleReleaseApiBaseUrl(audience, 'fixture-build'),
                    assertion: Redacted.make('fresh-owned-route-assertion'),
                    compositionRevision: revision,
                  }),
                dispatch: makeSymmyGovernedDispatch(Effect.succeed('roundtrip-correlation')),
                ownerFetch: ownerFetchFor(issuerId),
              }),
            ),
            (fixture) => Effect.promise(fixture.dispose),
          );
        const server = yield* startIssuer(internalRoute.issuerId);
        const get = yield* Effect.promise(() =>
          server.request(`${SYMMY_ROUTES.priceLists.path}?limit=1`, {
            headers: { 'x-api-key': validKey },
            method: 'GET',
          }),
        );
        expect(get.status).toBe(200);
        const publicBody = yield* Schema.decodeUnknownEffect(SymmyPriceListsResponseSchema, {
          onExcessProperty: 'error',
        })(yield* Effect.promise(() => get.json()));
        const [item] = publicBody.priceLists;
        expect(item?.code).toBe(sourceRecordId);
        assert.isOk(item);
        const post = (
          target: SymmyIngressServer,
          priceGroupRef: PublicPriceGroupRef,
          key: string,
          prices = [definePriceRow],
        ) =>
          Effect.promise(() =>
            target.request(SYMMY_ROUTES.priceListPricesBatch.path, {
              body: JSON.stringify({ priceGroupRef, prices }),
              headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-api-key': validKey },
              method: 'POST',
            }),
          );
        const accepted = yield* post(server, item.priceGroupRef, `roundtrip-${sequence}`);
        expect(accepted.status).toBe(202);
        expect(yield* Effect.promise(() => accepted.json())).toEqual({ jobId, status: 'queued' });
        expect(admitted).toHaveLength(1);
        const [payload] = admitted;
        expect(payload).toMatchObject({
          idempotencyKey: `roundtrip-${sequence}`,
          priceBatch: { priceGroupRef: nativePriceGroupRef, prices: [{ ...definePriceRow, effectiveFrom: definedAt }] },
          reviseFacts: [],
          routeKey: 'priceListPricesBatch',
        });
        for (const absent of ['code', 'contractVersion', 'fixtureId', 'plan', 'selector']) {
          expect(payload).not.toHaveProperty(absent);
        }

        // A list the key may not write to and a list that does not exist answer alike, before any admission.
        const otherList = { ...nativePriceGroupRef, resourceId: '50000000-0000-4000-8000-0000000000ff' };
        const unknownList = yield* post(server, otherList, `roundtrip-other-${sequence}`);
        expect(unknownList.status).toBe(403);
        const otherIssuer = yield* startIssuer('other-authorized-issuer');
        const crossIssuer = yield* post(otherIssuer, item.priceGroupRef, `roundtrip-cross-${sequence}`);
        expect(crossIssuer.status).toBe(403);
        expect(yield* Effect.promise(() => crossIssuer.json())).toEqual(
          yield* Effect.promise(() => unknownList.json()),
        );
        expect(admitted).toHaveLength(1);
        expect(associationPages.every(({ offset }) => offset === 0)).toBe(true);
      }
    }),
);

it.effect('refuses a REVISE item with 422 when the route has no price read source configured', () =>
  Effect.gen(function* reviseNeedsPriceSource() {
    const logicalRouteId = '71000000-0000-4000-8000-000000000001';
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/reads/symmy-route-context')) {
        return Response.json({
          ...priceBatchRoute(logicalRouteId, 'internal-price-groups'),
          allowedOwnerOperations: [
            ...priceBatchRoute(logicalRouteId, 'internal-price-groups').allowedOwnerOperations,
            { entrypointKey: 'commerce.pricing.api.price-schedule', moduleId: 'commerce.pricing', schemaVersion: '1' },
            {
              entrypointKey: 'commerce.pricing.api.price-group-source-prices',
              moduleId: 'commerce.pricing',
              schemaVersion: '1',
            },
          ],
        });
      }
      if (path.endsWith('/reads/price-group-source-associations')) {
        return Response.json({
          associations: [
            {
              priceGroupRef: nativePriceGroupRef,
              sourceCorrelation: {
                issuer: internalRoute.issuerId,
                mappingVersion: internalRoute.sourceMappingVersion,
                namespace: 'internal-price-groups',
                recordKey: 'CZ wholesale',
                routeId: logicalRouteId,
              },
            },
          ],
          count: 1,
          limit: 100,
          offset: 0,
        });
      }
      return Response.json({ jobId, phase: 'admitted' });
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: ({ audience }) =>
            Effect.succeed({
              apiBaseUrl: moduleReleaseApiBaseUrl(audience, 'fixture-build'),
              assertion: Redacted.make('fresh-owned-route-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('revise-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.priceListPricesBatch.path, {
        body: JSON.stringify({ priceGroupRef: nativePriceGroupRef, prices: [revisePriceRow] }),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(422);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ reason: 'projection_not_configured' });
  }),
);

it.effect('rejects foreign qualified codes and forged target hints before admitting a selected owner effect', () =>
  Effect.gen(function* selectedAliasScopeBoundary() {
    const rawCode = 'CZ wholesale';
    const logicalRouteId = '71000000-0000-4000-8000-000000000001';
    const selectorScope = {
      issuerId: internalRoute.issuerId,
      routeId: logicalRouteId,
      selectorKind: 'CUSTOMER_GROUP' as const,
      sourceNamespace: 'internal-customer-groups',
      tenantId: internalRoute.tenantId,
    };
    let routeReads = 0;
    let writes = 0;
    const ownerFetch: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/reads/symmy-route-context')) {
        routeReads += 1;
        return Promise.resolve(
          Response.json({
            ...internalRoute,
            resolvedCode: rawCode,
            selector: {
              kind: 'CUSTOMER_GROUP',
              source: {
                entityKind: 'CUSTOMER_GROUP',
                issuerId: selectorScope.issuerId,
                route: { integrationRouteId: logicalRouteId, tenantId: internalRoute.tenantId },
                sourceNamespace: selectorScope.sourceNamespace,
                sourceRecordId: rawCode,
              },
              target: nativeCustomerGroupRef,
            },
          }),
        );
      }
      writes += 1;
      return Promise.resolve(Response.json({ jobId, phase: 'admitted' }));
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-selector-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('selected-scope-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (code: string) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.customerGroupCustomersBatch.path.replace('{code}', code), {
          ...fixtureJson,
          headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const foreign = encodeSymmySourceSelector(
      { ...selectorScope, issuerId: 'another-issuer' },
      rawCode,
      nativeCustomerGroupRef.resourceId,
    );
    expect((yield* submit(foreign)).status).toBe(403);
    const wrongKind = encodeSymmySourceSelector(
      { ...selectorScope, selectorKind: 'PRICE_GROUP' },
      rawCode,
      nativeCustomerGroupRef.resourceId,
    );
    expect((yield* submit(wrongKind)).status).toBe(403);
    expect(routeReads).toBe(2);
    expect(writes).toBe(0);
    const before = server.authAttempts.length;
    expect(
      (yield* submit(encodeSymmySourceSelector(selectorScope, validKey, nativeCustomerGroupRef.resourceId))).status,
    ).toBe(403);
    expect(server.authAttempts).toHaveLength(before + 1);
    expect(
      (yield* submit(encodeSymmySourceSelector(selectorScope, rawCode, '30000000-0000-4000-8000-00000000000b'))).status,
    ).toBe(403);
    expect(routeReads).toBe(4);
    expect(writes).toBe(0);
  }),
);

it.effect('admits the public customers through the governed route without a plan or a contract version', () =>
  Effect.gen(function* governedCustomerAdmission() {
    const bodies: Schema.Json[] = [];
    const paths: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      bodies.push(Schema.decodeUnknownSync(Schema.Json)(await request.json()));
      return Response.json(
        path.endsWith('/reads/symmy-route-context')
          ? { ...internalRoute, allowedOwnerOperations: [internalProductInput.plan.items[0].effects[0].operation] }
          : { jobId, phase: 'admitted' },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-scoped-job-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-request-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customersBatch.path, {
        ...customersJson(),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(yield* Effect.promise(() => response.json())).toEqual({ jobId, status: 'queued' });
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
    ]);
    expect(bodies).toEqual([
      { replayIdempotencyKey: idempotencyKey, routeKey: 'customersBatch' },
      { customers: publicCustomerRows, idempotencyKey, routeKey: 'customersBatch' },
    ]);
    expect(JSON.stringify(bodies)).not.toContain('INTERNAL_C14');
  }),
);

it.effect('derives async scope from the governed route and obtains a fresh scoped admission assertion', () =>
  Effect.gen(function* governedBusinessAdmission() {
    const scopes: { readonly audience: string; readonly legalEntityId?: string }[] = [];
    const paths: string[] = [];
    const tokens: string[] = [];
    const bodies: Schema.Json[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      tokens.push(request.headers.get('authorization') ?? '');
      bodies.push(Schema.decodeUnknownSync(Schema.Json)(await request.json()));
      return Response.json(
        path.endsWith('/reads/symmy-route-context')
          ? { ...internalRoute, allowedOwnerOperations: [internalProductInput.plan.items[0].effects[0].operation] }
          : { jobId, phase: 'admitted' },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: (scope) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                apiBaseUrl,
                assertion: Redacted.make('fresh-scoped-job-assertion'),
                compositionRevision: revision,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-request-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        ...productsJson(),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(202);
    expect(scopes).toEqual([{ audience: 'symmy-integration', legalEntityId: internalRoute.legalEntityId }]);
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
    ]);
    expect(tokens).toEqual(['Bearer synthetic-assertion-1', 'Bearer fresh-scoped-job-assertion']);
    expect(bodies).toEqual([
      { replayIdempotencyKey: idempotencyKey, routeKey: 'productsBatch' },
      { idempotencyKey, priceGroupFacts: [], products: publicProductRows, routeKey: 'productsBatch' },
    ]);
  }),
);

it.effect('runs the synchronous generated owner operation and returns results without a job response', () =>
  Effect.gen(function* governedSynchronousItems() {
    const item = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          owner: 'commerce.customer-context',
          status: 'accepted_change',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const paths: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith('/reads/symmy-route-context')
          ? {
              ...internalRoute,
              allowedOwnerOperations: [
                {
                  entrypointKey: 'commerce.customer-context.create-customer-group',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              ],
              sourceEntityKind: 'CUSTOMER_GROUP',
              sourceNamespace: 'internal-groups',
            }
          : { items: [item] },
      );
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-sync-assertion'),
              compositionRevision: revision,
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-sync-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const groupInput = {
      contractVersion: 'INTERNAL_C14',
      plan: {
        items: [
          {
            effects: [
              {
                effectKey: 'group-create',
                intent: {
                  _tag: 'CustomerGroupCreate',
                  payload: {
                    businessCode: 'INTERNAL_GROUP',
                    description: 'Internal source grouping',
                    initialState: 'ACTIVE',
                    meaningKey: 'source-buyer-classification',
                    membershipCriteria: 'Explicit source group membership',
                    name: 'Internal buyers',
                    purpose: 'Buyer classification',
                    reason: 'Internal conformance fixture',
                  },
                },
                operation: {
                  entrypointKey: 'commerce.customer-context.create-customer-group',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
            ],
            itemKey: 'group-record',
            source: {
              entityKind: 'CUSTOMER_GROUP',
              issuerId: 'internal-issuer',
              sourceNamespace: 'internal-groups',
              sourceRecordId: 'opaque-source-group',
            },
            sourceOccurrenceId: 'internal-group-occurrence',
          },
        ],
      },
    };
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.customerGroupsBatch.path, {
        body: JSON.stringify(groupInput),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ items: [{ ...item, outcome: 'accepted' }] });
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      `${releasePath}/symmy-integration/actions/admit-symmy-sync`,
    ]);
    expect(paths.some((path) => path.includes('admit-symmy-job'))).toBe(false);
  }),
);

it.effect('uses the authorized source Product read through the normal owner release with tenant-only scope', () =>
  Effect.gen(function* governedSourceProductRead() {
    const scopes: { readonly audience: string; readonly legalEntityId?: string }[] = [];
    const paths: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      paths.push(path);
      return Response.json(path.endsWith('/reads/symmy-route-context') ? internalRoute : { count: 0, items: [] });
    };
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: (scope) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                apiBaseUrl: moduleReleaseApiBaseUrl('catalog', 'fixture-build'),
                assertion: Redacted.make('fresh-catalog-read-assertion'),
                compositionRevision: revision,
              };
            }),
          dispatch: makeSymmyGovernedDispatch(Effect.succeed('internal-read-correlation')),
          ownerFetch,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(`${SYMMY_ROUTES.adminProducts.path}?limit=2`, {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ count: 0, limit: 2, offset: 0, products: [] });
    expect(scopes).toEqual([{ audience: 'catalog' }]);
    expect(paths).toEqual([
      `${releasePath}/reads/symmy-route-context`,
      '/module-api/catalog/fixture-build/catalog-api/reads/catalog-source-product-page',
    ]);
  }),
);

it.effect('only accepts an operator fixture ID on the policy fixture routes', () =>
  Effect.gen(function* fixtureRouteContracts() {
    const admittedJobId = Schema.decodeUnknownSync(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.die('A fixture route cannot apply synchronous effects'),
            poll: () => Effect.die('A fixture route cannot poll jobs'),
            read: () => Effect.die('A fixture route cannot read owner data'),
            submit: () => Effect.succeed(admittedJobId),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const headers = { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey };
    for (const { path } of Object.values(SYMMY_FIXTURE_ROUTES)) {
      const admitted = yield* Effect.promise(() => server.request(path, { ...fixtureJson, headers, method: 'POST' }));
      expect(admitted.status).toBe(202);
      const extra = yield* Effect.promise(() =>
        server.request(path, {
          body: JSON.stringify({ fixtureId, plan: {} }),
          headers,
          method: 'POST',
        }),
      );
      expect(extra.status).toBe(400);
    }
  }),
);

it.effect('uses each approved route’s declared success status for internal fixtures', () =>
  Effect.gen(function* routesAllApprovedPaths() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = Schema.decodeUnknownSync(SymmyFixtureJobIdSchema)(jobId);
    const accepted = {
      effectId: '20000000-0000-4000-8000-000000000001',
      owner: 'test.catalog',
      status: 'accepted_change',
    };
    const notActivated = { owner: 'test.tax', reason: 'owner_not_activated', status: 'unsupported' };
    const indeterminate = {
      effectId: '20000000-0000-4000-8000-000000000002',
      owner: 'test.pricing',
      status: 'indeterminate',
    };
    const mixed = yield* decodeSymmyItemOutcome({
      effects: [accepted, notActivated, indeterminate],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const unavailable = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.inventory', status: 'unavailable' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const items = [
      {
        ...mixed,
        effects: [{ ...mixed.effects[0], ownerPrivateDetail: 'private fixture data' }, ...mixed.effects.slice(1)],
        ownerPrivateDetail: 'private fixture data',
      },
      unavailable,
    ] as const;
    const expectedItems = [
      { ...mixed, outcome: 'partial' },
      { ...unavailable, outcome: 'not_accepted' },
    ];
    const references = ['40000000-0000-4000-8000-000000000001'];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.succeed(items),
            poll: ({ request }) =>
              request.id === admittedJobId
                ? Effect.succeed({ items, phase: 'completed' })
                : Effect.fail(symmyFixtureJobNotFoundProblem),
            read: ({ request }) => Effect.succeed(readFixture(request.route, references)),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const definition of Object.values(SYMMY_ROUTES)) {
      const path = definition.path.replace('{code}', groupCode).replace('{id}', jobId);
      const isStock = path === SYMMY_ROUTES.inventoryStockBatch.path;
      const postBody = routeBody(path);
      const init =
        definition.method === 'POST'
          ? {
              ...postBody,
              headers:
                definition.mode === 'durable_job' || isStock
                  ? { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey }
                  : { ...fixtureJson.headers, 'x-api-key': validKey },
              method: definition.method,
            }
          : { headers: { 'x-api-key': validKey }, method: definition.method };
      const response = yield* Effect.promise(() => server.request(path, init));
      expect(response.status).toBe(definition.successStatus);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = yield* Effect.promise(() => response.json());
      const expectedBodies = {
        business_read: publicReadBody(path, references),
        durable_job: { jobId, status: 'queued' },
        item_results: {
          items: isStock
            ? expectedItems.map((item, index) => ({
                ...item,
                itemKey: `item-${index + 1}`,
                locationKey: 'warehouse-1',
              }))
            : expectedItems,
        },
        job_read: { items: expectedItems, jobId, status: 'indeterminate' },
      };
      expect(body).toEqual(expectedBodies[definition.mode]);
    }
    expect(server.authAttempts).toHaveLength(12);
    expect(server.assertions()).toBe(12);
    expect(forwarded).toEqual([
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminCustomers' },
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminProducts' },
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminRegions' },
      { code: groupCode, fixtureId, idempotencyKey, route: 'customerGroupCustomersBatch' },
      { fixtureId, route: 'customerGroupsBatch' },
      { customers: publicCustomerRows, idempotencyKey, route: 'customersBatch' },
      {
        idempotencyKey,
        route: 'inventoryStockBatch',
        stock: [stockRow('item-1', '2026-01-01T10:00:00.000Z'), stockRow('item-2', '2026-01-01T10:00:00.000Z')],
      },
      { id: jobId, route: 'job' },
      {
        idempotencyKey,
        priceBatch: {
          priceGroupRef: priceGroupRefOfBatch,
          prices: [{ ...definePriceRow, effectiveFrom: definedAt }, revisePriceRow],
        },
        route: 'priceListPricesBatch',
      },
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'priceLists' },
      { idempotencyKey, priceLists: [canonicalPriceList], route: 'priceListsBatchUpsert' },
      { idempotencyKey, products: publicProductRows, route: 'productsBatch' },
    ]);
  }),
);

it.effect('serves the public stock batch route with one keyed result per row and no internal contract', () =>
  Effect.gen(function* servesPublicStock() {
    const forwarded: SymmyIngressRequest[] = [];
    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        { effectId: '20000000-0000-4000-8000-000000000001', owner: 'commerce.inventory', status: 'accepted_change' },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const stale = yield* decodeSymmyItemOutcome({
      effects: [{ effectId: '20000000-0000-4000-8000-000000000002', owner: 'commerce.inventory', status: 'stale' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    let results: readonly [typeof accepted, ...(typeof accepted)[]] = [accepted, stale];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.succeed(results),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const post = (init: { readonly body: string }, headers: Record<string, string>) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.inventoryStockBatch.path, {
          ...init,
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
    const authorized = { 'idempotency-key': idempotencyKey, 'x-api-key': validKey };
    const rows = [stockRow('item-2'), { ...stockRow('item-1'), locationKey: 'warehouse-9' }];
    const response = yield* post(stockBatchJson(rows), authorized);
    expect(response.status).toBe(200);
    const body = yield* Effect.promise(() => response.json());
    expect(body).toEqual({
      items: [
        { ...accepted, itemKey: 'item-2', locationKey: 'warehouse-1', outcome: 'accepted' },
        { ...stale, itemKey: 'item-1', locationKey: 'warehouse-9', outcome: 'not_accepted' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('contractVersion');
    expect(forwarded).toEqual([
      {
        idempotencyKey,
        route: 'inventoryStockBatch',
        stock: [
          stockRow('item-2', '2026-01-01T10:00:00.000Z'),
          { ...stockRow('item-1', '2026-01-01T10:00:00.000Z'), locationKey: 'warehouse-9' },
        ],
      },
    ]);
    expect(forwarded[0]).not.toHaveProperty('contractVersion');
    expect(forwarded[0]).not.toHaveProperty('plan');
    // A replayed answer carries no extra or missing result: the pairing is by position, so a count mismatch is a defect.
    results = [accepted];
    expect((yield* post(stockBatchJson(rows), authorized)).status).toBe(500);
  }),
);

it.effect('answers the public stock batch route with 428 without a key and 400 for every body rule broken', () =>
  Effect.gen(function* rejectsStock() {
    let calls = 0;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: () => {
            calls += 1;
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const post = (body: string, headers: Record<string, string>, query = '') =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.inventoryStockBatch.path}${query}`, {
          body,
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
    const authorized = { 'idempotency-key': idempotencyKey, 'x-api-key': validKey };
    const valid = stockBatchJson([stockRow('item-1')]).body;
    const withoutKey = yield* post(valid, { 'x-api-key': validKey });
    expect(withoutKey.status).toBe(428);
    expect(withoutKey.headers.get('content-type')).toContain('application/problem+json');
    expect(calls).toBe(0);
    expect((yield* post(valid, { 'idempotency-key': idempotencyKey })).status).toBe(401);
    const [row] = [stockRow('item-1')];
    const { quantity: _quantity, ...withoutQuantity } = row;
    const bodies = [
      ['a quantity unit that is not an object', { stock: [{ ...row, quantity: { amount: '1', unitRef: 'u' } }] }],
      ['a row without quantity', { stock: [withoutQuantity] }],
      ['a row with a null field', { stock: [{ ...row, revision: null }] }],
      ['a contractVersion property', { contractVersion: 'INTERNAL_C14', stock: [row] }],
      ['a fixture identity', { fixtureId: 'internal-c14-fixture' }],
      ['a non-canonical amount', { stock: [{ ...row, quantity: { amount: '12.50', unitRef: stockUnitRef } }] }],
      ['a numeric amount', { stock: [{ ...row, quantity: { amount: 12, unitRef: stockUnitRef } }] }],
      ['a reservedQuantity property', { stock: [{ ...row, reservedQuantity: '1' }] }],
      ['an internal plan', { contractVersion: 'INTERNAL_C14', plan: { items: [] } }],
      ['an unknown property', { stock: [row], unknown: true }],
      ['an unknown row property', { stock: [{ ...row, sku: 'a' }] }],
      ['an empty stock list', { stock: [] }],
      ['no stock list', {}],
      ['seventeen rows', { stock: Array.from({ length: 17 }, () => row) }],
    ] as const;
    for (const [name, body] of bodies) {
      expect((yield* post(JSON.stringify(body), authorized)).status, name).toBe(400);
    }
    expect((yield* post(valid, authorized, '?contractVersion=INTERNAL_C14')).status).toBe(400);
    expect((yield* post(valid, authorized, '?limit=1')).status).toBe(400);
    expect((yield* post(valid, { ...authorized, 'idempotency-key': 'not a key' })).status).toBe(400);
    const reflected = yield* post(JSON.stringify({ stock: [{ ...row, itemKey: validKey }] }), authorized);
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(calls).toBe(0);
  }),
);

it.effect('serves the public price lists batch route with 202 queued and no internal contract', () =>
  Effect.gen(function* servesPublicPriceListsBatch() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = Schema.decodeUnknownSync(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const post = (body: string, headers: Record<string, string>, query = '') =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.priceListsBatchUpsert.path}${query}`, {
          body,
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
    const authorized = { 'idempotency-key': idempotencyKey, 'x-api-key': validKey };
    const valid = priceListsBatchJson([priceListRow]).body;
    const accepted = yield* post(valid, authorized);
    expect(accepted.status).toBe(202);
    const body = yield* Effect.promise(() => accepted.json());
    expect(body).toEqual({ jobId, status: 'queued' });
    expect(JSON.stringify(body)).not.toContain('contractVersion');
    expect(forwarded).toEqual([{ idempotencyKey, priceLists: [canonicalPriceList], route: 'priceListsBatchUpsert' }]);
    expect(JSON.stringify(forwarded)).not.toContain('contractVersion');
    const { prices: _prices, ...withoutPriceRows } = priceListRow;
    const withoutPrices = yield* post(JSON.stringify({ priceLists: [withoutPriceRows] }), authorized);
    expect(withoutPrices.status).toBe(202);

    const before = forwarded.length;
    expect((yield* post(valid, { 'x-api-key': validKey })).status).toBe(400);
    expect((yield* post(valid, { 'idempotency-key': idempotencyKey })).status).toBe(401);
    expect((yield* post(valid, { ...authorized, 'idempotency-key': 'not a key' })).status).toBe(400);
    expect((yield* post(valid, authorized, '?limit=1')).status).toBe(400);
    const { code: _code, ...withoutCode } = priceListRow;
    const { commercialScope: _scope, ...withoutScope } = priceRow;
    const { unitBasis: _basis, ...withoutBasis } = priceRow;
    const rejected = [
      ['an internal plan', { contractVersion: 'INTERNAL_C14', plan: { items: [] } }],
      ['a fixture identity', { fixtureId: 'internal-c14-fixture' }],
      ['a contractVersion property', { contractVersion: 'INTERNAL_C14', priceLists: [priceListRow] }],
      ['no price lists', {}],
      ['an empty price list array', { priceLists: [] }],
      ['seventeen price lists', { priceLists: Array.from({ length: 17 }, () => ({ ...priceListRow, prices: [] })) }],
      [
        'ten lists of ten prices',
        {
          priceLists: Array.from({ length: 10 }, () => ({
            ...priceListRow,
            prices: Array.from({ length: 10 }, () => priceRow),
          })),
        },
      ],
      ['a list without a code', { priceLists: [withoutCode] }],
      ['a lower-case business code', { priceLists: [{ ...priceListRow, businessCode: 'cz_wholesale' }] }],
      ['an effectiveTo', { priceLists: [{ ...priceListRow, effectiveTo: '2027-01-01T00:00:00Z' }] }],
      ['an endsAt', { priceLists: [{ ...priceListRow, endsAt: '2027-01-01T00:00:00Z' }] }],
      ['a type', { priceLists: [{ ...priceListRow, type: 'standard' }] }],
      ['a status', { priceLists: [{ ...priceListRow, status: 'active' }] }],
      ['a customerGroupCode', { priceLists: [{ ...priceListRow, customerGroupCode: 'g' }] }],
      ['a metadata property', { priceLists: [{ ...priceListRow, metadata: {} }] }],
      ['a negative amount', { priceLists: [{ ...priceListRow, prices: [{ ...priceRow, amount: '-1' }] }] }],
      ['a price without a scope', { priceLists: [{ ...priceListRow, prices: [withoutScope] }] }],
      ['a price without a unit basis', { priceLists: [{ ...priceListRow, prices: [withoutBasis] }] }],
      [
        'a scope without a market',
        { priceLists: [{ ...priceListRow, prices: [{ ...priceRow, commercialScope: { channelId: 'B2B' } }] }] },
      ],
      ['an unknown property', { priceLists: [priceListRow], unknown: true }],
    ] as const;
    for (const [name, rejectedBody] of rejected) {
      expect((yield* post(JSON.stringify(rejectedBody), authorized)).status, name).toBe(400);
    }
    const reflected = yield* post(JSON.stringify({ priceLists: [{ ...priceListRow, name: validKey }] }), authorized);
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(forwarded).toHaveLength(before);
  }),
);

it.effect('serves the public price batch route at its own path with 202 queued and no internal contract', () =>
  Effect.gen(function* servesPublicPriceBatch() {
    const forwarded: SymmyIngressRequest[] = [];
    const admittedJobId = Schema.decodeUnknownSync(SymmyFixtureJobIdSchema)(jobId);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.succeed(admittedJobId),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const post = (
      body: string,
      headers: Record<string, string>,
      query = '',
      path: string = SYMMY_ROUTES.priceListPricesBatch.path,
    ) =>
      Effect.promise(() =>
        server.request(`${path}${query}`, {
          body,
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
    const authorized = { 'idempotency-key': idempotencyKey, 'x-api-key': validKey };
    const batch = (prices: readonly Schema.Json[], extra: Readonly<Record<string, Schema.Json>> = {}) =>
      JSON.stringify({ priceGroupRef: priceGroupRefOfBatch, prices, ...extra });
    const accepted = yield* post(batch([definePriceRow, revisePriceRow]), authorized);
    expect(accepted.status).toBe(202);
    const body = yield* Effect.promise(() => accepted.json());
    expect(body).toEqual({ jobId, status: 'queued' });
    for (const hidden of ['contractVersion', 'selector']) {
      expect(JSON.stringify(body)).not.toContain(hidden);
      expect(JSON.stringify(forwarded)).not.toContain(hidden);
    }
    expect(forwarded).toEqual([
      {
        idempotencyKey,
        priceBatch: {
          priceGroupRef: priceGroupRefOfBatch,
          prices: [{ ...definePriceRow, effectiveFrom: definedAt }, revisePriceRow],
        },
        route: 'priceListPricesBatch',
      },
    ]);
    // The old path with a code segment finds no route.
    const oldPath = `${SYMMY_REST_PREFIX}/price-lists/some-code/prices/batch`;
    expect((yield* post(batch([definePriceRow]), authorized, '', oldPath)).status).toBe(404);

    const before = forwarded.length;
    const valid = batch([definePriceRow]);
    expect((yield* post(valid, { 'x-api-key': validKey })).status).toBe(400);
    expect((yield* post(valid, { 'idempotency-key': idempotencyKey })).status).toBe(401);
    expect((yield* post(valid, { ...authorized, 'idempotency-key': 'not a key' })).status).toBe(400);
    expect((yield* post(valid, authorized, '?limit=1')).status).toBe(400);
    const { commercialScope: _scope, ...withoutScope } = definePriceRow;
    const { unitBasis: _basis, ...withoutBasis } = definePriceRow;
    const { operation: _operation, ...withoutOperation } = definePriceRow;
    const { priceRef: _priceRef, ...reviseWithoutRef } = revisePriceRow;
    const { expectedRevision: _revision, ...reviseWithoutRevision } = revisePriceRow;
    const { priceGroupRef: _group, ...withoutGroup } = JSON.parse(valid);
    const rejected = [
      ['an internal plan', { contractVersion: 'INTERNAL_C14', plan: { items: [] } }],
      ['a fixture identity', { fixtureId: 'internal-c14-fixture' }],
      ['a contractVersion property', JSON.parse(batch([definePriceRow], { contractVersion: 'INTERNAL_C14' }))],
      ['no priceGroupRef', withoutGroup],
      [
        'a price ref as the priceGroupRef',
        JSON.parse(batch([definePriceRow], { priceGroupRef: revisePriceRow.priceRef })),
      ],
      ['a priceListCode', JSON.parse(batch([definePriceRow], { priceListCode: 'cz' }))],
      ['a code', JSON.parse(batch([definePriceRow], { code: 'cz' }))],
      ['a reason', JSON.parse(batch([{ ...definePriceRow, reason: 'free text' }]))],
      ['a sourceAssertion', JSON.parse(batch([{ ...definePriceRow, sourceAssertion: {} }]))],
      ['no prices', { priceGroupRef: priceGroupRefOfBatch }],
      ['an empty prices array', JSON.parse(batch([]))],
      ['seventeen prices', JSON.parse(batch(Array.from({ length: 17 }, () => definePriceRow)))],
      ['no operation', JSON.parse(batch([withoutOperation]))],
      ['another operation', JSON.parse(batch([{ ...definePriceRow, operation: 'RETIRE' }]))],
      ['a DEFINE without a scope', JSON.parse(batch([withoutScope]))],
      ['a DEFINE without a unit basis', JSON.parse(batch([withoutBasis]))],
      ['a DEFINE with a priceRef', JSON.parse(batch([{ ...definePriceRow, priceRef: revisePriceRow.priceRef }]))],
      ['a REVISE without a priceRef', JSON.parse(batch([reviseWithoutRef]))],
      ['a REVISE without an expectedRevision', JSON.parse(batch([reviseWithoutRevision]))],
      [
        'a REVISE with a commercialScope',
        JSON.parse(batch([{ ...revisePriceRow, commercialScope: definePriceRow.commercialScope }])),
      ],
      ['a negative amount', JSON.parse(batch([{ ...definePriceRow, amount: '-1' }]))],
      ['a numeric amount', JSON.parse(batch([{ ...definePriceRow, amount: 25 }]))],
      ['a lower-case currency', JSON.parse(batch([{ ...definePriceRow, currencyCode: 'czk' }]))],
      ['a variant ref as the productRef', JSON.parse(batch([{ ...definePriceRow, productRef: priceVariantRef }]))],
      ['two items for the same price', JSON.parse(batch([definePriceRow, definePriceRow]))],
      ['two REVISE items for the same price', JSON.parse(batch([revisePriceRow, revisePriceRow]))],
      ['an unknown property', JSON.parse(batch([definePriceRow], { unknown: true }))],
    ] as const;
    for (const [name, rejectedBody] of rejected) {
      expect((yield* post(JSON.stringify(rejectedBody), authorized)).status, name).toBe(400);
    }
    const reflected = yield* post(batch([{ ...definePriceRow, amount: validKey }]), authorized);
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(forwarded).toHaveLength(before);
  }),
);

it.effect('serves the public regions body from its own query', () =>
  Effect.gen(function* servesPublicRegions() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(regionsProjection),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (query: string) =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.adminRegions.path}${query}`, {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
    const [region] = publicRegionsBody.regions;
    const rejected = [
      'code=a',
      'sourceRecordId=a',
      'afterRecordId=a',
      'priceLimit=1',
      'priceOffset=0',
      'contractVersion=INTERNAL_C14',
      'order=name',
      'unknown=1',
      'limit=0',
      'limit=101',
      'limit=abc',
      'offset=-1',
      'offset=abc',
      'q=',
      'q=%20%20',
      `q=${'a'.repeat(201)}`,
      'fields=nope',
      'fields=marketCode,',
      'fields=%2BmarketCode',
      'fields=',
      'fields=marketCode,%20id',
    ];
    for (const query of rejected) {
      const response = yield* get(`?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(forwarded).toEqual([]);

    const plain = yield* get('');
    expect(plain.status).toBe(200);
    expect(yield* Effect.promise(() => plain.json())).toEqual(publicRegionsBody);
    const paged = yield* get('?limit=1&offset=1&q=%20cz%20');
    expect(paged.status).toBe(200);
    expect(forwarded).toEqual([
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminRegions' },
      { query: { contractVersion: 'INTERNAL_C14', limit: 1, offset: 1, q: 'cz' }, route: 'adminRegions' },
    ]);

    const selected = yield* get('?fields=marketCode,marketCode,id');
    expect(selected.status).toBe(200);
    expect(yield* Effect.promise(() => selected.json())).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      regions: [{ id: region?.id, marketCode: 'CZ_NATIVE' }],
    });
    expect(forwarded.at(-1)).toEqual({ query: { contractVersion: 'INTERNAL_C14' }, route: 'adminRegions' });

    const reflected = yield* get(`?q=${validKey}`);
    expect(reflected.status).toBe(400);
  }),
);

it.effect('serves the public customers body from its own query', () =>
  Effect.gen(function* servesPublicCustomers() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(customersProjection),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (query: string) =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.adminCustomers.path}${query}`, {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
    const rejected = [
      'afterRecordId=a',
      'code=a',
      'sourceRecordId=a',
      'contractVersion=INTERNAL_C14',
      'priceLimit=1',
      'priceOffset=0',
      'order=name',
      'unknown=1',
      'limit=0',
      'limit=101',
      'limit=abc',
      'offset=-1',
      'offset=abc',
      'q=',
      'q=%20%20',
      `q=${'a'.repeat(301)}`,
      'fields=bogus',
      'fields=',
      'fields=party,',
      'fields=%2Bparty',
      'fields=party.firstName',
      'fields=party,%20ico',
      `fields=${'sourceRecordId,'.repeat(20)}`,
    ];
    for (const query of rejected) {
      const response = yield* get(`?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(forwarded).toEqual([]);

    const plain = yield* get('');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    const plainBody = yield* Effect.promise(() => plain.text());
    expect(JSON.parse(plainBody)).toEqual(publicCustomersReadBody);
    for (const forbiddenKey of [
      'contractVersion',
      'projection',
      'unsupported_fields',
      'unsupportedFields',
      'nextRecordId',
      'source_record_id',
      'business_name',
    ]) {
      expect(plainBody).not.toContain(forbiddenKey);
    }
    const paged = yield* get('?limit=1&offset=1&q=%20ada%20');
    expect(paged.status).toBe(200);
    for (const fields of ['id', 'sourceRecordId', 'partyRef', 'profile', 'party', 'businessName', 'ico']) {
      expect((yield* get(`?fields=${fields}`)).status, fields).toBe(200);
    }
    expect((yield* get('?fields=ico,ico,party')).status).toBe(200);
    expect(forwarded).toEqual([
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminCustomers' },
      { query: { contractVersion: 'INTERNAL_C14', limit: 1, offset: 1, q: 'ada' }, route: 'adminCustomers' },
      ...['id', 'sourceRecordId', 'partyRef', 'profile', 'party', 'businessName', 'ico'].map((name) => ({
        query: { contractVersion: 'INTERNAL_C14', fields: [name] },
        route: 'adminCustomers',
      })),
      { query: { contractVersion: 'INTERNAL_C14', fields: ['ico', 'ico', 'party'] }, route: 'adminCustomers' },
    ]);

    const reflected = yield* get(`?q=${validKey}`);
    expect(reflected.status).toBe(400);
  }),
);

it.effect('never answers the customers read with anything but the public body', () =>
  Effect.gen(function* refusesNonCustomersProjection() {
    const privateReference = 'private fixture reference';
    for (const answer of [[privateReference], productsProjection]) {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          start({
            dispatch: {
              apply: () => Effect.fail(symmyUnavailableProblem),
              poll: () => Effect.fail(symmyUnavailableProblem),
              read: () => Effect.succeed(answer),
              submit: () => Effect.fail(symmyUnavailableProblem),
            },
          }),
        ),
        (fixture) => Effect.promise(fixture.dispose),
      );
      const response = yield* Effect.promise(() =>
        server.request(SYMMY_ROUTES.adminCustomers.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
      );
      expect(response.status).toBe(503);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('references');
      expect(body).not.toContain(privateReference);
      expect(JSON.stringify(server.logs)).not.toContain(privateReference);
    }
  }),
);

it.effect('serves the public products body from its own query', () =>
  Effect.gen(function* servesPublicProducts() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(productsProjection),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (query: string) =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.adminProducts.path}${query}`, {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
    const [product] = publicProductsReadBody.products;
    const rejected = [
      'afterRecordId=a',
      'code=a',
      'sourceRecordId=a',
      'contractVersion=INTERNAL_C14',
      'priceLimit=1',
      'priceOffset=0',
      'order=name',
      'sales_channel_id=sc',
      'price_list_id=pl',
      'status=ACTIVE',
      'id=a',
      'created_at%5B%24gte%5D=2026-01-01',
      'unknown=1',
      'limit=0',
      'limit=101',
      'limit=abc',
      'offset=-1',
      'offset=abc',
      'q=',
      'q=%20%20',
      `q=${'a'.repeat(201)}`,
      'fields=nope',
      'fields=id',
      'fields=product.name,',
      'fields=%2Bproduct.name',
      'fields=-product.name',
      'fields=variantSources.id',
      'fields=product.variants.variantId',
      'fields=product.name,%20sourceRecordId',
      'fields=',
      `fields=${'sourceRecordId,'.repeat(40)}`,
    ];
    for (const query of rejected) {
      const response = yield* get(`?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(forwarded).toEqual([]);

    const plain = yield* get('');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    const plainBody = yield* Effect.promise(() => plain.text());
    expect(JSON.parse(plainBody)).toEqual(publicProductsReadBody);
    for (const forbiddenKey of [
      'contractVersion',
      'projection',
      'unsupported_fields',
      'unsupportedFields',
      'nextRecordId',
      'source_record_id',
    ]) {
      expect(plainBody).not.toContain(forbiddenKey);
    }
    const paged = yield* get('?limit=1&offset=1&q=%20chair%20');
    expect(paged.status).toBe(200);
    expect(forwarded).toEqual([
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'adminProducts' },
      { query: { contractVersion: 'INTERNAL_C14', limit: 1, offset: 1, q: 'chair' }, route: 'adminProducts' },
    ]);

    for (const fields of [
      'sourceRecordId',
      'product',
      'product.productRef',
      'product.revision',
      'product.lifecycle',
      'product.catalogReady',
      'product.name',
      'product.description',
      'product.createdAt',
      'product.updatedAt',
      'product.variants',
      'variantSources',
    ]) {
      expect((yield* get(`?fields=${fields}`)).status, fields).toBe(200);
    }
    const idOnly = yield* get('?fields=sourceRecordId');
    expect(yield* Effect.promise(() => idOnly.json())).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      products: [{ id: product?.id, sourceRecordId: 'source-product-a' }],
    });
    const nested = yield* get('?fields=product.name,variantSources,product.name,product.description');
    expect(yield* Effect.promise(() => nested.json())).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      products: [{ id: product?.id, product: { name: 'Native chair' }, variantSources: product?.variantSources }],
    });
    const parent = yield* get('?fields=product.name,product');
    expect(yield* Effect.promise(() => parent.json())).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      products: [{ id: product?.id, product: productsNative }],
    });
    expect(forwarded.at(-1)).toEqual({ query: { contractVersion: 'INTERNAL_C14' }, route: 'adminProducts' });

    const reflected = yield* get(`?q=${validKey}`);
    expect(reflected.status).toBe(400);
  }),
);

it.effect('never answers the products read with anything but the public body', () =>
  Effect.gen(function* refusesNonProductsProjection() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(['10000000-0000-4000-8000-000000000001']),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminProducts.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    expect(response.status).toBe(503);
    expect(yield* Effect.promise(() => response.text())).not.toContain('references');
  }),
);

it.effect('serves the public price lists body from its own query', () =>
  Effect.gen(function* servesPublicPriceLists() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(priceListsProjection),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (query: string) =>
      Effect.promise(() =>
        server.request(`${SYMMY_ROUTES.priceLists.path}${query}`, {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
    for (const query of [
      'code=a',
      'sourceRecordId=a',
      'afterRecordId=a',
      'contractVersion=INTERNAL_C14',
      'q=a',
      'fields=name',
      'unknown=1',
      'limit=0',
      'limit=101',
      'limit=abc',
      'offset=-1',
      'priceLimit=0',
      'priceLimit=101',
      'priceOffset=-1',
    ]) {
      const response = yield* get(`?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(forwarded).toEqual([]);

    const plain = yield* get('');
    expect(plain.status).toBe(200);
    expect(yield* Effect.promise(() => plain.json())).toEqual(publicPriceListsBody);
    const paged = yield* get('?limit=1&offset=1&priceLimit=2&priceOffset=3');
    expect(paged.status).toBe(200);
    expect(forwarded).toEqual([
      { query: { contractVersion: 'INTERNAL_C14' }, route: 'priceLists' },
      {
        query: { contractVersion: 'INTERNAL_C14', limit: 1, offset: 1, priceLimit: 2, priceOffset: 3 },
        route: 'priceLists',
      },
    ]);
  }),
);

it.effect('never answers the price lists read with anything but the public body', () =>
  Effect.gen(function* refusesNonPriceListProjection() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(['10000000-0000-4000-8000-000000000001']),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.priceLists.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    expect(response.status).toBe(503);
    expect(yield* Effect.promise(() => response.text())).not.toContain('references');
  }),
);

it.effect('never answers the regions read with anything but the public body', () =>
  Effect.gen(function* refusesNonProjection() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: () => Effect.fail(symmyUnavailableProblem),
            read: () => Effect.succeed(['10000000-0000-4000-8000-000000000001']),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminRegions.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    expect(response.status).toBe(503);
    expect(yield* Effect.promise(() => response.text())).not.toContain('references');
  }),
);

it.effect('rejects missing, invalid and wrong-kind API keys before dispatch', () =>
  Effect.gen(function* rejectsInvalidCredentials() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (key?: string) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.adminProducts.path, {
          headers: key === undefined ? {} : { 'x-api-key': key },
          method: 'GET',
        }),
      );
    const missing = yield* get();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('ApiKey');
    expect((yield* get('wrong-key')).status).toBe(401);
    expect((yield* get(wrongKindKey)).status).toBe(403);
    expect(server.authAttempts).toEqual(['wrong-key', wrongKindKey]);
    expect(forwarded).toEqual([]);
  }),
);

it.effect('authenticates and admits the caller of every route before decoding or mapping its request', () =>
  Effect.gen(function* authenticatesBeforeDecoding() {
    const forwarded: SymmyIngressRequest[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          observe: (request) => {
            forwarded.push(request);
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    /** A body, query or job id that the route decoders answer with 400 once the caller is admitted. */
    const send = (definition: { readonly method: string; readonly path: string }, key?: string) => {
      const credential = key === undefined ? {} : { 'x-api-key': key };
      const path = definition.path.replace('{code}', groupCode).replace('{id}', 'not-a-job-id');
      return Effect.promise(() =>
        definition.method === 'POST'
          ? server.request(path, {
              body: '{"unexpected":true}',
              headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...credential },
              method: 'POST',
            })
          : server.request(`${path}?audience=outside-module`, { headers: credential, method: definition.method }),
      );
    };
    const routes = Object.entries({ ...SYMMY_ROUTES, ...SYMMY_FIXTURE_ROUTES });
    for (const [, definition] of routes) {
      for (const key of [undefined, 'wrong-key']) {
        const unauthenticated = yield* send(definition, key);
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers.get('www-authenticate')).toContain('ApiKey');
        expect(unauthenticated.headers.get('cache-control')).toBe('no-store');
        expect(yield* Effect.promise(() => unauthenticated.json())).toEqual(invalid);
      }
      expect((yield* send(definition, wrongKindKey)).status).toBe(403);
      // Admission's own 429 and 503 answer the request before any validation problem.
      for (const [key, problem] of [
        [rateLimitedKey, rateLimited],
        [unavailableKey, symmyUnavailableProblem],
      ] as const) {
        const refused = yield* send(definition, key);
        expect(refused.status).toBe(problem.status);
        expect(refused.headers.get('cache-control')).toBe('no-store');
        expect(yield* Effect.promise(() => refused.json())).toEqual(problem);
      }
      const admitted = yield* send(definition, validKey);
      expect(admitted.status).toBe(400);
      expect(admitted.headers.get('cache-control')).toBe('no-store');
      expect(yield* Effect.promise(() => admitted.json())).toMatchObject({
        type: 'https://ontos.dev/problems/symmy-invalid',
      });
    }
    const attempts = ['wrong-key', wrongKindKey, rateLimitedKey, unavailableKey, validKey];
    expect(server.authAttempts).toEqual(routes.flatMap(() => attempts));
    // Each admission names the matched endpoint, whose workload it checks before decoding.
    expect(server.admissionRoutes).toEqual(routes.flatMap(([route]) => attempts.map(() => route)));
    expect(forwarded).toEqual([]);
  }),
);

it.effect('keeps job progress separate from whether completed items succeeded', () =>
  Effect.gen(function* distinguishesFixtureJobProgress() {
    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          originalStatus: 'accepted_no_change',
          owner: 'test.catalog',
          status: 'duplicate',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const denied = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.catalog', status: 'denied' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const cases = [
      { body: { status: 'queued' }, id: jobId, state: { phase: 'admitted' } },
      {
        body: { status: 'running' },
        id: '10000000-0000-4000-8000-000000000002',
        state: { phase: 'running' },
      },
      {
        body: { items: [{ ...accepted, outcome: 'accepted' }], status: 'completed_all' },
        id: '10000000-0000-4000-8000-000000000003',
        state: { items: [accepted], phase: 'completed' },
      },
      {
        body: { items: [{ ...denied, outcome: 'not_accepted' }], status: 'completed_none' },
        id: '10000000-0000-4000-8000-000000000004',
        state: { items: [denied], phase: 'completed' },
      },
      {
        body: {
          items: [
            { ...denied, outcome: 'not_accepted' },
            { ...accepted, outcome: 'accepted' },
          ],
          status: 'completed_partial',
        },
        id: '10000000-0000-4000-8000-000000000006',
        state: { items: [denied, accepted], phase: 'completed' },
      },
    ] as const;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          dispatch: {
            apply: () => Effect.fail(symmyUnavailableProblem),
            poll: ({ request }) => {
              const job = cases.find(({ id }) => request.id === id);
              return job === undefined ? Effect.fail(symmyFixtureJobNotFoundProblem) : Effect.succeed(job.state);
            },
            read: () => Effect.fail(symmyUnavailableProblem),
            submit: () => Effect.fail(symmyUnavailableProblem),
          },
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const { body, id } of cases) {
      const response = yield* Effect.promise(() =>
        server.request(SYMMY_ROUTES.job.path.replace('{id}', id), {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ ...body, jobId: id });
    }
    const missingJobId = '10000000-0000-4000-8000-000000000005';
    const missing = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', missingJobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    const missingBody = yield* Effect.promise(() => missing.text());
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect(missingBody).toContain('SymmyFixtureJobNotFoundProblem');
    expect(missingBody).not.toContain(missingJobId);
    const malformedId = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', 'not-a-uuid'), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(malformedId.status).toBe(400);
    const withQuery = yield* Effect.promise(() =>
      server.request(`${SYMMY_ROUTES.job.path.replace('{id}', jobId)}?x=1`, {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(withQuery.status).toBe(400);
  }),
);

it.effect('does not dispatch wrong methods, unrecognized paths or cross-mounted endpoints', () =>
  Effect.gen(function* isolatesNativeMounts() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ enableBatch: true })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const wrongMethod = yield* Effect.promise(() => server.request(SYMMY_ROUTES.productsBatch.path, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
    const extension = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminProducts.path, { method: 'PROPFIND' }),
    );
    expect(extension.status).toBe(405);
    expect(extension.headers.get('allow')).toBe('GET');
    const head = yield* Effect.promise(() => server.request(SYMMY_ROUTES.adminProducts.path, { method: 'HEAD' }));
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    const unknown = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/admin/users/me`, { method: 'GET' }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');
    const malformedPath = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/admin//products`, { method: 'GET' }),
    );
    expect(malformedPath.status).toBe(404);
    const wrongMount = yield* Effect.promise(() =>
      server.request(`${shellPrefix}${SYMMY_ROUTES.adminProducts.path}`, { method: 'GET' }, shellPrefix),
    );
    expect(wrongMount.status).toBe(404);
    const encodedWrongMount = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/%61pi/symmy/v1/admin/products`, { method: 'GET' }, shellPrefix),
    );
    expect(encodedWrongMount.status).toBe(404);
    const shellAlias = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/auth/api-key/gateway-context`, { method: 'POST' }),
    );
    expect(shellAlias.status).toBe(404);
    expect(server.shellCalls()).toBe(0);
    const normalShell = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/auth/api-key/gateway-context`, { method: 'POST' }, shellPrefix),
    );
    expect(normalShell.status).toBe(200);
    expect(server.shellCalls()).toBe(1);
    const batch = yield* Effect.promise(() =>
      server.request(
        `${shellPrefix}${DEFAULT_DATA_BATCH_ENDPOINT}`,
        {
          body: JSON.stringify({
            batchId: 'ordinary-shell',
            items: [{ id: 'session', method: 'GET', path: '/auth/session' }],
            protocolVersion: 2,
            sentAt: 0,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
        shellPrefix,
      ),
    );
    expect(batch.status).toBe(200);
    expect(yield* Effect.promise(() => batch.json())).toMatchObject({
      batchId: 'ordinary-shell',
      items: [{ id: 'session', status: 200 }],
      protocolVersion: 2,
    });
    expect(server.shellCalls()).toBe(2);
    const aliasOpenApi = yield* Effect.promise(() =>
      server.request(`${SYMMY_REST_PREFIX}/openapi.json`, { method: 'GET' }),
    );
    expect(aliasOpenApi.status).toBe(404);
    const normalOpenApi = yield* Effect.promise(() =>
      server.request(`${shellPrefix}/openapi.json`, { method: 'GET' }, shellPrefix),
    );
    expect(normalOpenApi.status).toBe(200);
    const normalOpenApiDocument = yield* Effect.promise(() => normalOpenApi.text());
    expect(normalOpenApiDocument).toContain('/auth/api-key/gateway-context');
    expect(normalOpenApiDocument).not.toContain(SYMMY_REST_PREFIX);
    expect(server.authAttempts).toEqual([]);
  }),
);

it.effect('fails closed by default and rejects caller-provided authority in fixture inputs', () =>
  Effect.gen(function* rejectsUnconfiguredAndUnverifiedInputs() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const response = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.adminRegions.path, { headers: { 'x-api-key': validKey }, method: 'GET' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const noReceipt = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        ...productsJson(),
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(noReceipt.status).toBe(503);
    expect(yield* Effect.promise(() => noReceipt.json())).not.toHaveProperty('jobId');
    const noJobStatus = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(noJobStatus.status).toBe(503);
    expect(yield* Effect.promise(() => noJobStatus.text())).toContain('SymmyUnavailableProblem');
    const invalidBody = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.productsBatch.path, {
        body: '{"fixtureId":"internal-c14-fixture","audience":"outside-module"}',
        headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
        method: 'POST',
      }),
    );
    expect(invalidBody.status).toBe(400);
    const invalidQuery = yield* Effect.promise(() =>
      server.request(`${SYMMY_ROUTES.adminProducts.path}?audience=outside-module`, {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    expect(invalidQuery.status).toBe(400);
    expect(server.authAttempts).toEqual([validKey, validKey, validKey, validKey, validKey]);
  }),
);

it.effect('requires an exact idempotency key and rejects reflected credentials before dispatch', () =>
  Effect.gen(function* rejectsInvalidDurableIdentity() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start()),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = (headers: HeadersInit, body = productsJson().body) =>
      Effect.promise(() => server.request(SYMMY_ROUTES.productsBatch.path, { body, headers, method: 'POST' }));
    const common = { ...fixtureJson.headers, 'x-api-key': validKey };
    expect((yield* submit(common)).status).toBe(400);
    expect((yield* submit({ ...common, 'idempotency-key': 'first, second' })).status).toBe(400);
    expect((yield* submit({ ...common, 'idempotency-key': `job-${validKey}` })).status).toBe(400);
    const reflected = yield* submit(
      { ...common, 'idempotency-key': idempotencyKey },
      productsJson({ products: [{ name: validKey, variants: [{}] }] }).body,
    );
    expect(reflected.status).toBe(400);
    expect(yield* Effect.promise(() => reflected.text())).not.toContain(validKey);
    expect(server.authAttempts).toEqual([validKey, validKey, validKey, validKey]);
  }),
);

it.effect('uses the generated owner Action and Read with distinct fresh assertions and transport keys', () =>
  Effect.gen(function* usesExactGeneratedOperations() {
    const calls: { readonly headers: Record<string, string>; readonly path: string; readonly payload: Schema.Json }[] =
      [];
    const fetchOwner: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const payload = Schema.decodeUnknownSync(Schema.Json)(await request.json());
      calls.push({ headers: Object.fromEntries(request.headers), path: new URL(request.url).pathname, payload });
      return Response.json({ jobId, phase: 'admitted' });
    };
    let identifier = 0;
    const dispatch = makeSymmyGovernedDispatch(
      Effect.sync(() => {
        identifier += 1;
        return `fixture-identifier-${identifier}`;
      }),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ dispatch, ownerFetch: fetchOwner })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const submit = () =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.customerGroupCustomersBatch.path.replace('{code}', groupCode), {
          ...fixtureJson,
          headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
          method: 'POST',
        }),
      );
    const poll = yield* Effect.promise(() =>
      server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
        headers: { 'x-api-key': validKey },
        method: 'GET',
      }),
    );
    const first = yield* submit();
    const retry = yield* submit();
    expect([poll.status, first.status, retry.status]).toEqual([200, 202, 202]);
    expect(yield* Effect.promise(() => poll.json())).toEqual({ jobId, status: 'queued' });
    expect(yield* Effect.promise(() => first.json())).toEqual({ jobId, status: 'queued' });
    expect(yield* Effect.promise(() => retry.json())).toEqual({ jobId, status: 'queued' });
    expect(calls.map(({ path }) => path)).toEqual([
      `${releasePath}/reads/symmy-job-status`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
      `${releasePath}/symmy-integration/actions/admit-symmy-job`,
    ]);
    const intent = { code: groupCode, fixtureId, idempotencyKey, routeKey: 'customerGroupCustomersBatch' };
    expect(calls.map(({ payload }) => payload)).toEqual([{ jobId }, intent, intent]);
    expect(calls.map(({ headers }) => headers['idempotency-key'])).toEqual([
      undefined,
      'fixture-identifier-3',
      'fixture-identifier-5',
    ]);
    expect(calls.map(({ headers }) => headers['authorization'])).toEqual([
      'Bearer synthetic-assertion-1',
      'Bearer synthetic-assertion-2',
      'Bearer synthetic-assertion-3',
    ]);
    expect(calls.map(({ headers }) => headers['x-correlation-id'])).toEqual([
      'fixture-identifier-1',
      'fixture-identifier-2',
      'fixture-identifier-4',
    ]);
    expect(calls.every(({ headers }) => headers['x-ontos-composition-revision'] === revision)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(validKey);
  }),
);

it.effect('preserves governed execution outcomes and pending recovery without owner details', () =>
  Effect.gen(function* projectsGovernedExecution() {
    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000001',
          owner: 'test.catalog',
          status: 'accepted_change',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000001',
    });
    const denied = yield* decodeSymmyItemOutcome({
      effects: [{ owner: 'test.pricing', status: 'denied' }],
      itemId: '30000000-0000-4000-8000-000000000002',
    });
    const uncertain = yield* decodeSymmyItemOutcome({
      effects: [
        {
          effectId: '20000000-0000-4000-8000-000000000003',
          owner: 'test.inventory',
          status: 'indeterminate',
        },
      ],
      itemId: '30000000-0000-4000-8000-000000000003',
    });
    const acceptedResult = { ...accepted, outcome: 'accepted' };
    const deniedResult = { ...denied, outcome: 'not_accepted' };
    const uncertainResult = { ...uncertain, outcome: 'not_accepted' };
    const cases = [
      { expected: { items: [], status: 'queued' }, items: [], phase: 'admitted' },
      { expected: { items: [acceptedResult], status: 'running' }, items: [accepted], phase: 'running' },
      {
        expected: { items: [acceptedResult, deniedResult], status: 'blocked' },
        items: [accepted, denied],
        phase: 'blocked',
      },
      {
        expected: { items: [acceptedResult, deniedResult], status: 'completed_partial' },
        items: [accepted, denied],
        phase: 'completed_all',
      },
      {
        expected: { items: [acceptedResult, uncertainResult], status: 'indeterminate' },
        items: [accepted, uncertain],
        phase: 'indeterminate',
      },
      { items: [], phase: 'completed_none' },
    ] as const;
    let ownerCase: (typeof cases)[number] = cases[0];
    const privateDetail = 'fixture-private-source-record';
    const fetchOwner: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          items: ownerCase.items.map((item) => ({
            ...item,
            effects: item.effects.map((effect) => ({ ...effect, originalTarget: privateDetail })),
            sourceRecord: privateDetail,
          })),
          jobId,
          phase: ownerCase.phase,
          routeRevision: privateDetail,
        }),
      );
    const dispatch = makeSymmyGovernedDispatch(Effect.succeed('fresh-poll-key'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ dispatch, ownerFetch: fetchOwner })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const entry of cases) {
      ownerCase = entry;
      const response = yield* Effect.promise(() =>
        server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
          headers: { 'x-api-key': validKey },
          method: 'GET',
        }),
      );
      expect(response.status).toBe('expected' in entry ? 200 : 503);
      const body = yield* Effect.promise(() => response.json());
      if ('expected' in entry) {
        expect(body).toEqual({ ...entry.expected, jobId });
      }
      expect(JSON.stringify(body)).not.toContain(privateDetail);
    }
  }),
);

it.effect('refuses unlisted owner targets before consulting release authority', () =>
  Effect.gen(function* refusesUnlistedReleaseTargets() {
    let lookups = 0;
    const authority = Layer.succeed(
      ActiveApplicationCompositionService,
      makeActiveApplicationCompositionService(
        Effect.sync(() => {
          lookups += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ActiveApplicationCompositionUnavailableError({
                reason: 'Fixture has no configured Symmy executable',
              }),
            ),
          ),
        ),
      ),
    );
    const relayOrigin = 'https://symmy-owner-relay.invalid';
    const denied = [
      `https://foreign.example.test${releasePath}/symmy-integration/actions/admit-symmy-job`,
      `${relayOrigin}${releasePath}/actions/unlisted-action`,
      `${relayOrigin}${releasePath}/reads/symmy-job-status?extra=true`,
      `${relayOrigin}${apiBaseUrl}/reads/symmy-job-status`,
      `${relayOrigin}/module-api/another-owner/fixture-build/another-owner-api/actions/admit-symmy-job`,
    ];
    for (const url of denied) {
      expect(
        yield* Effect.flip(forwardSymmyOwnerRelease(url, { method: 'POST' }).pipe(Effect.provide(authority))),
      ).toEqual(symmyUnavailableProblem);
    }
    expect(lookups).toBe(0);
    const configuredPath = yield* Effect.flip(
      forwardSymmyOwnerRelease(`${relayOrigin}${releasePath}/reads/symmy-job-status`, { method: 'POST' }).pipe(
        Effect.provide(authority),
      ),
    );
    expect(configuredPath).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(lookups).toBe(1);
  }),
);

it.effect('projects owner admission and polling failures without owner details', () =>
  Effect.gen(function* projectsGovernedFailures() {
    const cases = [
      { expected: 401, ownerStatus: 401, tag: 'AdmitSymmyJobActionAuthenticationProblem' },
      { code: 'action_permission_denied', expected: 403, ownerStatus: 403, tag: 'AdmitSymmyJobActionForbiddenProblem' },
      { code: 'symmy_job_route_denied', expected: 403, ownerStatus: 403, tag: 'AdmitSymmyJobRouteDeniedProblem' },
      {
        code: 'symmy_job_intent_conflict',
        expected: 409,
        ownerStatus: 409,
        tag: 'AdmitSymmyJobIntentConflictProblem',
      },
      { expected: 503, ownerStatus: 502, tag: 'UnknownUpstreamFailure' },
      { expected: 404, ownerStatus: 404, poll: true, tag: 'SymmyJobStatusNotFoundProblem' },
      { expected: 403, ownerStatus: 403, poll: true, tag: 'SymmyJobStatusForbiddenProblem' },
      { expected: 503, ownerStatus: 503, poll: true, tag: 'SymmyJobStatusUnavailableProblem' },
    ] as const;
    const privateDetail = 'owner-only diagnostic';
    let ownerCase: (typeof cases)[number] = cases[0];
    const fetchOwner: typeof fetch = (input, init) =>
      Promise.resolve(
        new URL(new Request(input, init).url).pathname.endsWith('/reads/symmy-route-context')
          ? Response.json({
              ...internalRoute,
              allowedOwnerOperations: [internalProductInput.plan.items[0].effects[0].operation],
            })
          : Response.json(
              {
                _tag: ownerCase.tag,
                code: 'code' in ownerCase ? ownerCase.code : undefined,
                detail: privateDetail,
                retryable: ownerCase.ownerStatus === 503 ? true : undefined,
                status: ownerCase.ownerStatus,
                title: 'Private owner operation',
                type: 'https://ontos.dev/problems/test-owner-operation',
              },
              { headers: { 'content-type': 'application/problem+json' }, status: ownerCase.ownerStatus },
            ),
      );
    const dispatch = makeSymmyGovernedDispatch(Effect.succeed('fresh-action-key'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        start({
          acquireOwnerAssertion: () =>
            Effect.succeed({
              apiBaseUrl,
              assertion: Redacted.make('fresh-scoped-job-assertion'),
              compositionRevision: revision,
            }),
          dispatch,
          ownerFetch: fetchOwner,
        }),
      ),
      (fixture) => Effect.promise(fixture.dispose),
    );
    for (const entry of cases) {
      ownerCase = entry;
      const response = yield* Effect.promise(() =>
        'poll' in entry
          ? server.request(SYMMY_ROUTES.job.path.replace('{id}', jobId), {
              headers: { 'x-api-key': validKey },
              method: 'GET',
            })
          : server.request(SYMMY_ROUTES.customersBatch.path, {
              ...customersJson(),
              headers: { ...fixtureJson.headers, 'idempotency-key': idempotencyKey, 'x-api-key': validKey },
              method: 'POST',
            }),
      );
      expect(response.status).toBe(entry.expected);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain(privateDetail);
      expect(body).not.toContain(jobId);
      expect(body).not.toContain(idempotencyKey);
      if (entry.expected === 401) {
        expect(response.headers.get('www-authenticate')).toContain('ApiKey');
      }
    }
  }),
);

it.effect('logs a correlated defect classification and sanitizes the gateway problem', () =>
  Effect.gen(function* sanitizesDefect() {
    const requestId = 'fixture-c14-request-id';
    const traceId = '0123456789abcdef0123456789abcdef';
    const defect = Cause.combine(Cause.die({ apiKey: validKey }), Cause.die('sensitive-dispatch-details'));
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => start({ defect })),
      (fixture) => Effect.promise(fixture.dispose),
    );
    const get = (correlationId: string, requestTraceId = traceId) =>
      Effect.promise(() =>
        server.request(SYMMY_ROUTES.adminProducts.path, {
          headers: {
            traceparent: `00-${requestTraceId}-0123456789abcdef-01`,
            'x-api-key': validKey,
            'x-correlation-id': correlationId,
          },
          method: 'GET',
        }),
      );
    const response = yield* get(requestId);
    const text = yield* Effect.promise(() => response.text());
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(text).toContain('GatewayInternalProblem');
    expect(text).not.toContain(validKey);
    expect((yield* get(`before-${validKey}-after`)).status).toBe(500);
    expect((yield* get(validKey, validKey)).status).toBe(500);
    const errorLogs = server.logs.filter((log) => log.level === 'ERROR');
    expect(errorLogs).toMatchObject(
      [requestId, traceId, 'missing'].map((correlationId) => ({
        annotations: { correlationId },
        message: ['Unexpected Symmy ingress defect', { reasons: ['Die', 'Die'] }],
      })),
    );
    expect(JSON.stringify(server.logs)).not.toContain(validKey);
    expect(JSON.stringify(server.logs)).not.toContain('sensitive-dispatch-details');
  }),
);
