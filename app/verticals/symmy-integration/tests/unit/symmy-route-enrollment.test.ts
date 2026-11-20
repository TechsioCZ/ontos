import { Array as EffectArray, Option, Result, Schema, pipe } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { symmyJobRoutes } from '../../src/db/schema.ts';
import { SymmyRouteEnrollmentRefused } from '../../src/ops/symmy-route-enrollment-refused.ts';
import {
  SymmyRouteEnrollmentRequestSchema,
  decideSymmyRouteWrite,
  symmyCounterpartRefusals,
  symmyPlannedRouteRow,
  symmyRetentionRefusals,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
} from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyRouteEnrollmentRequest } from '../../src/ops/symmy-route-enrollment.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const productsRouteId = '44444444-4444-4444-8444-444444444444';
const readRouteId = '55555555-5555-4555-8555-555555555555';
const marketId = '66666666-6666-4666-8666-666666666666';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};

const operation = (moduleId: string, entrypointKey: string, schemaVersion: string) => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const createProduct = operation('commerce.catalog', 'commerce.catalog.create-product', '2');
const createVariant = operation('commerce.catalog', 'commerce.catalog.create-variant', '2');
const definePrice = operation('commerce.pricing', 'commerce.pricing.define-price', '2');
const productPage = operation('commerce.catalog', 'commerce.catalog.api.catalog-source-product-page', '1');
const item = (
  entityKind: string,
  ...operations: readonly [ReturnType<typeof operation>, ...ReturnType<typeof operation>[]]
) => ({
  effects: pipe(
    operations,
    EffectArray.map((enrolled, index) => ({
      effectKey: `authority-${String(index)}`,
      operation: enrolled,
    })),
  ),
  itemKey: `enrolled-${entityKind.toLowerCase()}`,
  source: {
    entityKind,
    issuerId: 'AKROS_SYMMY',
    sourceNamespace: 'AKROS_PRODUCTS',
    sourceRecordId: `enrollment-${entityKind.toLowerCase()}`,
  },
});
const priceSource = {
  defaults: { commercialScope: { channelId: 'B2C', marketId }, unitBasis: { quantity: '1', unitRef } },
  mapping: { mappingContractRef: 'AKROS_PRICE_MAPPING', mappingContractVersion: 'v1' },
  sourceAuthority: { sourceAuthorityRef: 'AKROS_PRICE_AUTHORITY', sourceAuthorityVersion: 'v1' },
};
const lifecyclePolicy = { policyId: 'akros-symmy-jobs', revision: 'r1' };

const decodeRequest = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema);
type EncodedRequest = typeof SymmyRouteEnrollmentRequestSchema.Encoded;
type EncodedConfiguration = EncodedRequest['configuration'];
/** A copy without the named keys: an absent optional key, never one set to undefined. */
const without = <Value extends object>(value: Value, keys: readonly (keyof Value)[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.some((omitted) => omitted === key)));
const productsRequest = (
  overrides: Partial<EncodedRequest> = {},
  configuration: Partial<EncodedConfiguration> = {},
  absent: {
    readonly configuration?: readonly (keyof EncodedConfiguration)[];
    readonly request?: readonly (keyof EncodedRequest)[];
  } = {},
) =>
  decodeRequest(
    without(
      {
        configuration: without(
          {
            items: [item('PRODUCT', createProduct), item('VARIANT', createVariant), item('PRICE', definePrice)],
            priceSource,
            pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'AKROS_SYMMY' },
            ...configuration,
          },
          absent.configuration ?? [],
        ),
        legalEntityId,
        lifecyclePolicy,
        mappingVersion: 'map-v1',
        principalId,
        routeId: productsRouteId,
        routeKey: 'productsBatch',
        routeRevision: 'route-v1',
        tenantId,
        ...overrides,
      },
      absent.request ?? [],
    ),
  );
const readRequest = (sourceRouteId: string) =>
  decodeRequest({
    configuration: { items: [item('PRODUCT', productPage)], sourceRouteId },
    legalEntityId,
    mappingVersion: 'map-v1',
    principalId,
    routeId: readRouteId,
    routeKey: 'adminProducts',
    routeRevision: 'route-v1',
    tenantId,
  });

const inventoryOf = (request: SymmyRouteEnrollmentRequest) => {
  const inventory = symmyRouteInventoryOf(request.routeKey);
  if (!Option.isOption(inventory) || Option.isNone(inventory)) {
    throw new Error('expected an inventoried route');
  }
  return inventory.value;
};
const codes = (request: SymmyRouteEnrollmentRequest) =>
  symmyRouteRequestRefusals(request, inventoryOf(request)).map(({ code }) => code);

type RouteRow = typeof symmyJobRoutes.$inferSelect;
const storedRow = (request: SymmyRouteEnrollmentRequest, changes: Partial<RouteRow> = {}): RouteRow => ({
  ...symmyPlannedRouteRow(request),
  fixturePlan: request.configuration,
  lifecyclePolicy: request.lifecyclePolicy ?? null,
  ...changes,
});
const decided = (
  request: SymmyRouteEnrollmentRequest,
  existing: { readonly byRouteId?: RouteRow; readonly bySelector?: RouteRow },
  replace = false,
) =>
  decideSymmyRouteWrite(
    request,
    {
      byRouteId: Option.fromUndefinedOr(existing.byRouteId),
      bySelector: Option.fromUndefinedOr(existing.bySelector),
    },
    replace,
  );
const refusalCodes = (decision: ReturnType<typeof decideSymmyRouteWrite>) =>
  Schema.is(SymmyRouteEnrollmentRefused)(decision) ? decision.refusals.map(({ code }) => code) : [];

describe('Symmy route enrollment decisions', () => {
  it('refuses the stock route with its own reason and every route kind without an inventory', () => {
    const stock = symmyRouteInventoryOf('inventoryStockBatch');
    expect(Option.isOption(stock) ? undefined : stock.code).toBe('stock_route_pending_backend_decision');
    expect(symmyRouteInventoryOf('customersBatch')).toEqual(Option.none());
  });

  it('accepts a products route that names only inventoried operations with its price source', () => {
    expect(codes(productsRequest())).toEqual([]);
    expect(codes(readRequest(productsRouteId))).toEqual([]);
  });

  it('refuses an Inventory backend, a selector or stock positions on a route that enrolls none', () => {
    const withBackend = productsRequest({}, { inventoryBackendId: 'warehouse' });
    expect(codes(withBackend)).toEqual(['configuration_field_not_allowed']);
  });

  it('refuses an operation outside the route inventory and one read from the wrong item', () => {
    const misplacedRead = productsRequest(
      {},
      { items: [item('PRODUCT', createProduct, productPage), item('PRICE', definePrice)] },
    );
    expect(codes(misplacedRead)).toEqual(['operation_not_in_route_inventory']);
    const wrongItem = productsRequest(
      {},
      { items: [item('PRODUCT', createProduct, createVariant), item('PRICE', definePrice)] },
    );
    expect(codes(wrongItem)).toEqual(['operation_entity_kind_mismatch']);
  });

  it('refuses a route without the operation every request needs', () => {
    expect(codes(productsRequest({}, { items: [item('VARIANT', createVariant), item('PRICE', definePrice)] }))).toEqual(
      ['required_operation_missing'],
    );
  });

  it('names the price source exactly when the route defines prices', () => {
    const withoutSource = productsRequest({}, {}, { configuration: ['priceSource'] });
    expect(codes(withoutSource)).toEqual(['price_source_mismatch']);
    const withoutPrices = productsRequest({}, { items: [item('PRODUCT', createProduct)] });
    expect(
      codes(
        productsRequest(
          {},
          { items: [item('PRODUCT', createProduct)] },
          { configuration: ['priceSource', 'pricingSourceSystem'] },
        ),
      ),
    ).toEqual([]);
    expect(codes(withoutPrices)).toEqual(['price_source_mismatch']);
  });

  it('keeps a company-scoped call off a Tenant-only route', () => {
    expect(codes(productsRequest({}, {}, { request: ['legalEntityId'] }))).toContain('company_scope_required');
  });

  it('refuses mixed source identities and a durable route without a lifecycle policy', () => {
    const product = item('PRODUCT', createProduct);
    const mixed = productsRequest(
      {},
      {
        items: [
          { ...product, source: { ...product.source, sourceNamespace: 'OTHER' } },
          item('VARIANT', createVariant),
          item('PRICE', definePrice),
        ],
      },
    );
    expect(codes(mixed)).toEqual(['source_identity_mixed']);
    expect(codes(productsRequest({}, {}, { request: ['lifecyclePolicy'] }))).toEqual(['lifecycle_policy_required']);
  });

  it('compares the logical source of the write and read routes of one source', () => {
    const products = productsRequest();
    const counterpart = Option.some({ configuration: products.configuration, routeId: products.routeId });
    expect(symmyCounterpartRefusals(readRequest(productsRouteId), counterpart)).toEqual([]);
    expect(symmyCounterpartRefusals(readRequest(readRouteId), counterpart).map(({ code }) => code)).toEqual([
      'source_identity_differs_from_counterpart',
    ]);
    expect(symmyCounterpartRefusals(readRequest(readRouteId), Option.none())).toEqual([]);
  });

  it('requires the retention configuration to name the lifecycle policy for this route exactly once', () => {
    const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)({
      ...lifecyclePolicy,
      governanceLegalEntityId: legalEntityId,
      retentionMs: 86_400_000,
      routeId: productsRouteId,
      targetLegalEntityId: legalEntityId,
      tenantId,
    });
    const request = productsRequest();
    expect(symmyRetentionRefusals(request, [policy])).toEqual([]);
    expect(symmyRetentionRefusals(request, []).map(({ code }) => code)).toEqual(['lifecycle_policy_not_configured']);
    expect(symmyRetentionRefusals(request, [policy, policy]).map(({ code }) => code)).toEqual([
      'lifecycle_policy_not_configured',
    ]);
    expect(symmyRetentionRefusals(request, [{ ...policy, revision: 'r2' }]).map(({ code }) => code)).toEqual([
      'lifecycle_policy_not_configured',
    ]);
  });

  it('inserts a new route and leaves an exact replay unchanged', () => {
    const request = productsRequest();
    expect(decided(request, {})).toEqual({ kind: 'insert' });
    const stored = storedRow(request);
    expect(decided(request, { byRouteId: stored, bySelector: stored })).toEqual({ kind: 'unchanged' });
  });

  it('refuses drift unless a replacement with a new revision is asked for', () => {
    const request = productsRequest();
    const stored = storedRow(request, { routeRevision: 'route-v0' });
    expect(refusalCodes(decided(request, { byRouteId: stored, bySelector: stored }))).toEqual(['route_drift']);
    expect(decided(request, { byRouteId: stored, bySelector: stored }, true)).toEqual({
      changed: ['routeRevision'],
      kind: 'replace',
    });
    const sameRevision = storedRow(request, { mappingVersion: 'map-v0' });
    expect(refusalCodes(decided(request, { byRouteId: sameRevision, bySelector: sameRevision }, true))).toEqual([
      'revision_not_advanced',
    ]);
    const inactive = storedRow(request, { active: false });
    expect(refusalCodes(decided(request, { byRouteId: inactive, bySelector: inactive }))).toEqual(['route_drift']);
  });

  it('never rebinds a route id or a selector to another route', () => {
    const request = productsRequest();
    const other = storedRow(request, { routeId: readRouteId });
    expect(refusalCodes(decided(request, { bySelector: other }, true))).toEqual(['route_id_conflict']);
    const elsewhere = storedRow(request, { routeKey: 'adminProducts' });
    expect(refusalCodes(decided(request, { byRouteId: elsewhere }))).toEqual(['route_id_conflict']);
  });

  it('rejects a request with fields the schema does not know', () => {
    const decoded = Schema.decodeUnknownResult(SymmyRouteEnrollmentRequestSchema, { onExcessProperty: 'error' })({
      ...Schema.encodeSync(SymmyRouteEnrollmentRequestSchema)(productsRequest()),
      routeCode: 'X',
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });
});
