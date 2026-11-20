import { Array as EffectArray, Option, Result, Schema, pipe } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { symmyJobRoutes } from '../../src/db/schema.ts';
import {
  addAddressOperation,
  addContactOperation,
  counterpartyProfileOperation,
  createPartyOperation,
  onboardOperation,
  organizationIcoOperation,
  retailProfileOperation,
} from '../../src/persistence/symmy-customer-plan.ts';
import { reviseOperation } from '../../src/persistence/symmy-price-batch-plan.ts';
import { groupOperation, priceOperation } from '../../src/persistence/symmy-price-list-plan.ts';
import {
  createProductOperation,
  createVariantOperation,
  updateProductOperation,
  variantFactsOperation,
} from '../../src/persistence/symmy-product-plan.ts';
import { symmyIntegrationRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import { symmyCallInMode } from '../../src/ops/symmy-route-bindings.ts';
import { SymmyRouteEnrollmentRefused } from '../../src/ops/symmy-route-enrollment-refused.ts';
import {
  SymmyOutstandingWorkSchema,
  SymmyRouteEnrollmentRequestSchema,
  SymmyRouteReferenceSchema,
  decideSymmyRouteDeactivation,
  decideSymmyRouteWrite,
  symmyCoreRefusals,
  symmyOutstandingRefusals,
  symmyPlannedRouteRow,
  symmyRelatedRouteRefusals,
  symmyRetentionRefusals,
  symmyRouteEnrollmentLockKey,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
  symmyRuntimePrerequisites,
} from '../../src/ops/symmy-route-enrollment.ts';
import type {
  SymmyEnrollmentRouteKey,
  SymmyRouteChange,
  SymmyRouteEnrollmentRequest,
  SymmyRouteInventory,
} from '../../src/ops/symmy-route-enrollment.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const routeId = '44444444-4444-4444-8444-444444444444';
const peerRouteId = '55555555-5555-4555-8555-555555555555';
const sourceRouteId = '66666666-6666-4666-8666-666666666666';
const otherLegalEntityId = '77777777-7777-4777-8777-777777777777';
const groupId = '77777777-7777-4777-8777-777777777777';
const marketId = '88888888-8888-4888-8888-888888888888';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;

const operation = (moduleId: string, entrypointKey: string, schemaVersion = '1') => ({
  entrypointKey,
  moduleId,
  schemaVersion,
});
const createProduct = operation('commerce.catalog', 'commerce.catalog.create-product', '2');
const createVariant = operation('commerce.catalog', 'commerce.catalog.create-variant', '2');
const definePrice = operation('commerce.pricing', 'commerce.pricing.define-price', '2');
const revisePrice = operation('commerce.pricing', 'commerce.pricing.revise-price', '2');
const productPage = operation('commerce.catalog', 'commerce.catalog.api.catalog-source-product-page');
const associations = operation(
  'pricing.price-group-catalog',
  'pricing.price-group-catalog.api.price-group-source-associations',
);
const groupDefinition = operation(
  'pricing.price-group-catalog',
  'pricing.price-group-catalog.api.price-group-definition',
);
const createPriceGroup = operation('pricing.price-group-catalog', 'pricing.price-group-catalog.create-price-group');
const createParty = operation('party.registry', 'party.registry.create-party');
const onboard = operation('party.registry', 'party.registry.counterparty-customer-onboard');
const retailProfile = operation(
  'commerce.customer-context',
  'commerce.customer-context.ensure-retail-customer-profile',
);
const counterpartyProfile = operation(
  'commerce.customer-context',
  'commerce.customer-context.create-counterparty-purchasing-profile',
);
const customerPage = operation(
  'commerce.customer-context',
  'commerce.customer-context.api.customer-profile-source-page',
);
const createGroup = operation('commerce.customer-context', 'commerce.customer-context.create-customer-group');
const updateGroup = operation('commerce.customer-context', 'commerce.customer-context.update-customer-group');
const groupDefinitionSource = operation(
  'commerce.customer-context',
  'commerce.customer-context.api.customer-group-definition-source',
);
const applyMembership = operation(
  'commerce.customer-context',
  'commerce.customer-context.apply-customer-group-membership-source',
);
const currentMarkets = operation('commerce.market-catalog', 'commerce.market-catalog.api.current-market-catalog');
const priceSchedule = operation('commerce.pricing', 'commerce.pricing.api.price-schedule');
const groupSourcePrices = operation('commerce.pricing', 'commerce.pricing.api.price-group-source-prices');
const currencies = operation('commerce.pricing', 'commerce.pricing.api.current-supported-currencies');

type EncodedRequest = typeof SymmyRouteEnrollmentRequestSchema.Encoded;
type EncodedConfiguration = EncodedRequest['configuration'];
type EncodedItem = EncodedConfiguration['items'][number];
type Operation = EncodedItem['effects'][number]['operation'];
let itemCount = 0;
const item = (
  entityKind: string,
  operations: readonly [Operation, ...Operation[]],
  issuerId = 'AKROS_SYMMY',
): EncodedItem => {
  itemCount += 1;
  return {
    effects: pipe(
      operations,
      EffectArray.map((enrolled, index) => ({ effectKey: `authority-${String(index)}`, operation: enrolled })),
    ),
    itemKey: `enrolled-${String(itemCount)}`,
    source: { entityKind, issuerId, sourceNamespace: 'AKROS', sourceRecordId: `enrollment-${String(itemCount)}` },
  };
};
const priceSource: Pick<EncodedConfiguration, 'priceSource' | 'pricingSourceSystem'> = {
  priceSource: {
    defaults: { commercialScope: { channelId: 'B2C', marketId }, unitBasis: { quantity: '1', unitRef } },
    mapping: { mappingContractRef: 'AKROS_PRICE_MAPPING', mappingContractVersion: 'v1' },
    sourceAuthority: { sourceAuthorityRef: 'AKROS_PRICE_AUTHORITY', sourceAuthorityVersion: 'v1' },
  },
  pricingSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'AKROS_SYMMY' },
};
const lifecyclePolicy = { policyId: 'akros-symmy-jobs', revision: 'r1' };
const selector: NonNullable<EncodedConfiguration['selector']> = {
  kind: 'CUSTOMER_GROUP',
  source: {
    entityKind: 'CUSTOMER_GROUP',
    issuerId: 'AKROS_SYMMY',
    route: { integrationRouteId: sourceRouteId, tenantId },
    sourceNamespace: 'AKROS',
    sourceRecordId: 'VIP',
  },
  target: {
    moduleId: 'commerce.customer-context',
    resourceId: groupId,
    resourceType: 'commerce.customer-context.customer-group',
    tenantId,
  },
};

const decode = Schema.decodeUnknownSync(SymmyRouteEnrollmentRequestSchema);
const write = { legalEntityId, lifecyclePolicy };
type Enrollable = Exclude<
  SymmyEnrollmentRouteKey,
  'assortmentRulesFixtureBatch' | 'inventoryStockBatch' | 'sellerVatDeclarationsFixtureBatch'
>;
type RouteFields = Omit<
  EncodedRequest,
  'mappingVersion' | 'principalId' | 'routeId' | 'routeKey' | 'routeRevision' | 'tenantId'
>;
/** A valid request of every route kind; a test changes one field of it at a time. */
const valid = {
  adminCustomers: () => ({ configuration: { items: [item('CUSTOMER', [customerPage])] }, legalEntityId }),
  adminProducts: () => ({ configuration: { items: [item('PRODUCT', [productPage])] } }),
  adminRegions: () => ({ configuration: { items: [item('REGION', [currentMarkets, currencies])] }, legalEntityId }),
  customerGroupCustomersBatch: () => ({
    ...write,
    configuration: { items: [item('CUSTOMER', [applyMembership])], selector, sourceRouteId },
    routeCode: 'VIP',
  }),
  customerGroupsBatch: () => ({
    ...write,
    configuration: { items: [item('CUSTOMER_GROUP', [createGroup, groupDefinitionSource])] },
  }),
  customersBatch: () => ({ ...write, configuration: { items: [item('CUSTOMER', [createParty, retailProfile])] } }),
  priceListPricesBatch: () => ({
    ...write,
    configuration: { items: [item('PRICE', [definePrice, revisePrice, associations])], ...priceSource },
  }),
  priceLists: () => ({ configuration: { items: [item('PRICE_GROUP', [associations, groupDefinition])] } }),
  priceListsBatchUpsert: () => ({
    ...write,
    configuration: { items: [item('PRICE_GROUP', [createPriceGroup]), item('PRICE', [definePrice])], ...priceSource },
  }),
  productsBatch: () => ({
    ...write,
    configuration: {
      items: [item('PRODUCT', [createProduct]), item('VARIANT', [createVariant]), item('PRICE', [definePrice])],
      ...priceSource,
    },
  }),
} satisfies Record<Enrollable, () => RouteFields>;
const enrollable: readonly Enrollable[] = [
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'customerGroupCustomersBatch',
  'customerGroupsBatch',
  'customersBatch',
  'priceListPricesBatch',
  'priceLists',
  'priceListsBatchUpsert',
  'productsBatch',
];
/** A copy without the named keys: an absent optional key, never one set to undefined. */
const without = <Value extends object>(value: Value, keys: readonly (keyof Value)[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.some((omitted) => omitted === key)));
const fields = (routeKey: Enrollable) => ({
  mappingVersion: 'map-v1',
  principalId,
  routeId,
  routeKey,
  routeRevision: 'route-v1',
  tenantId,
  ...valid[routeKey](),
});
const request = (
  routeKey: Enrollable,
  changes: Partial<EncodedRequest> = {},
  omit: readonly (keyof EncodedRequest)[] = [],
) => decode(without({ ...fields(routeKey), ...changes }, omit));
const withConfiguration = (
  routeKey: Enrollable,
  configuration: Partial<EncodedConfiguration>,
  omit: readonly (keyof EncodedConfiguration)[] = [],
) =>
  decode({
    ...fields(routeKey),
    configuration: without({ ...valid[routeKey]().configuration, ...configuration }, omit),
  });

const inventoryOf = (routeKey: SymmyEnrollmentRouteKey): SymmyRouteInventory => {
  const found = symmyRouteInventoryOf(routeKey);
  if (!Option.isOption(found) || Option.isNone(found)) {
    throw new Error(`expected an inventory of ${routeKey}`);
  }
  return found.value;
};
const codes = (enrollment: SymmyRouteEnrollmentRequest) =>
  symmyRouteRequestRefusals(enrollment, inventoryOf(enrollment.routeKey)).map(({ code }) => code);
/** The request refusals of a request, each as code and detail. */
const requestRefusals = (enrollment: SymmyRouteEnrollmentRequest) =>
  symmyRouteRequestRefusals(enrollment, inventoryOf(enrollment.routeKey)).map(
    ({ code, detail }) => `${code}: ${detail}`,
  );

type RouteRow = typeof symmyJobRoutes.$inferSelect;
const storedRow = (enrollment: SymmyRouteEnrollmentRequest, changes: Partial<RouteRow> = {}): RouteRow => ({
  ...symmyPlannedRouteRow(enrollment),
  changeToken: 1,
  fixturePlan: enrollment.configuration,
  lifecyclePolicy: enrollment.lifecyclePolicy ?? null,
  ...changes,
});
type WriteChange = Exclude<SymmyRouteChange, { readonly kind: 'deactivate' }>;
const enroll: WriteChange = { kind: 'enroll' };
const replaceAt = (expectedChangeToken: number): WriteChange => ({ expectedChangeToken, kind: 'replace' });
const decided = (
  enrollment: SymmyRouteEnrollmentRequest,
  existing: { readonly byRouteId?: RouteRow; readonly bySelector?: RouteRow },
  change: WriteChange = enroll,
) =>
  decideSymmyRouteWrite(
    enrollment,
    { byRouteId: Option.fromUndefinedOr(existing.byRouteId), bySelector: Option.fromUndefinedOr(existing.bySelector) },
    change,
  );
/** A deactivation of the request's route at a token, with the route its selector holds. */
const stopAt = (enrollment: SymmyRouteEnrollmentRequest, expectedChangeToken: number, bySelector?: RouteRow) =>
  decideSymmyRouteDeactivation(enrollment, Option.fromUndefinedOr(bySelector), expectedChangeToken);
/** The related-route refusals of a request, each as code and detail. */
const relatedRefusals = (enrollment: SymmyRouteEnrollmentRequest, related: readonly RouteRow[]) =>
  symmyRelatedRouteRefusals(enrollment, inventoryOf(enrollment.routeKey), related).refusals.map(
    ({ code, detail }) => `${code}: ${detail}`,
  );
const refusalCodes = (
  decision: ReturnType<typeof decideSymmyRouteDeactivation> | ReturnType<typeof decideSymmyRouteWrite>,
) => (Schema.is(SymmyRouteEnrollmentRefused)(decision) ? decision.refusals.map(({ code }) => code) : []);

describe('Symmy route inventories', () => {
  it('refuses the stock route with its own reason and names no inventory for an operator fixture route', () => {
    const stock = symmyRouteInventoryOf('inventoryStockBatch');
    expect(Option.isOption(stock) ? undefined : stock.code).toBe('stock_route_pending_inventory_setup');
    expect(symmyRouteInventoryOf('assortmentRulesFixtureBatch')).toEqual(Option.none());
  });

  it('resolves every executor operation and adapter read to exactly one call Symmy registers in its mode', () => {
    for (const routeKey of enrollable) {
      const inventory = inventoryOf(routeKey);
      for (const enrolled of inventory.operations.filter(({ caller }) => caller === 'executor')) {
        for (const reference of [enrolled, ...(enrolled.reads ?? [])]) {
          const calls = symmyIntegrationRegisteredWorkloadCalls.filter(
            (call) =>
              symmyCallInMode(inventory.admission)(call) &&
              call.entrypointKey === reference.entrypointKey &&
              call.schemaVersion === reference.schemaVersion &&
              !('recoveryOf' in call),
          );
          expect([routeKey, reference.entrypointKey, calls.length]).toEqual([routeKey, reference.entrypointKey, 1]);
        }
      }
    }
  });

  it('lists every operation a plan builder calls in its route inventory, at the builder version and entity kind', () => {
    const built: readonly (readonly [
      Enrollable,
      { readonly entrypointKey: string; readonly moduleId: string; readonly schemaVersion: string },
      string | undefined,
    ])[] = [
      ['productsBatch', createProductOperation, 'PRODUCT'],
      ['productsBatch', updateProductOperation, 'PRODUCT'],
      ['productsBatch', createVariantOperation, 'VARIANT'],
      ['productsBatch', variantFactsOperation, 'VARIANT'],
      ['productsBatch', priceOperation, 'PRICE'],
      ['priceListsBatchUpsert', groupOperation, 'PRICE_GROUP'],
      ['priceListsBatchUpsert', priceOperation, 'PRICE'],
      ['priceListPricesBatch', priceOperation, 'PRICE'],
      ['priceListPricesBatch', reviseOperation, 'PRICE'],
      ['customersBatch', createPartyOperation, undefined],
      ['customersBatch', onboardOperation, undefined],
      ['customersBatch', addContactOperation, undefined],
      ['customersBatch', retailProfileOperation, undefined],
      ['customersBatch', counterpartyProfileOperation, undefined],
      ['customersBatch', addAddressOperation, undefined],
      ['customersBatch', organizationIcoOperation, undefined],
    ];
    for (const [routeKey, builderOperation, entityKind] of built) {
      const listed = inventoryOf(routeKey).operations.filter(
        (candidate) =>
          candidate.caller === 'executor' &&
          candidate.moduleId === builderOperation.moduleId &&
          candidate.entrypointKey === builderOperation.entrypointKey &&
          candidate.schemaVersion === builderOperation.schemaVersion,
      );
      expect([
        routeKey,
        builderOperation.entrypointKey,
        listed.map(({ entityKind: listedKind }) => listedKind),
      ]).toEqual([routeKey, builderOperation.entrypointKey, [entityKind]]);
    }
  });

  it('accepts a request of every Symmy route kind that names only inventoried operations', () => {
    for (const routeKey of enrollable) {
      expect([routeKey, codes(request(routeKey))]).toEqual([routeKey, []]);
    }
  });
});

describe('Symmy route request refusals', () => {
  it('refuses an executable intent in the enrolled configuration', () => {
    const group = item('CUSTOMER_GROUP', [createGroup, groupDefinitionSource]);
    const intent = {
      _tag: 'CustomerGroupCreate',
      payload: {
        businessCode: 'VIP',
        description: 'Enrolled group',
        initialState: 'ACTIVE',
        meaningKey: 'VIP_GROUP',
        membershipCriteria: 'Explicit source criteria',
        name: 'VIP',
        purpose: 'Classification',
        reason: 'Explicit source definition',
        source: {
          definitionEvidence: { kind: 'SOURCE_RECORD', reference: 'akros:group-vip', revision: 'source-1' },
          effectId: groupId,
          issuer: 'AKROS_SYMMY',
          mappingRevision: 'map-v1',
          namespace: 'AKROS',
          order: 1,
          recordId: 'VIP',
          revision: 'source-1',
          route: { id: routeId, revision: 'route-v1' },
          sourceCode: 'AKROS',
        },
      },
    } as const;
    const withIntent: EncodedItem = { ...group, effects: [{ ...group.effects[0], intent }, ...group.effects.slice(1)] };
    expect(codes(withConfiguration('customerGroupsBatch', { items: [withIntent] }))).toEqual(['owner_intent_enrolled']);
  });

  it('refuses stock positions, an Inventory backend, a selector off the membership route and a policy on a read', () => {
    expect(codes(withConfiguration('productsBatch', { inventoryBackendId: 'warehouse' }))).toEqual([
      'configuration_field_not_allowed',
    ]);
    expect(codes(withConfiguration('customerGroupsBatch', { selector }))).toEqual(['configuration_field_not_allowed']);
    expect(codes(request('adminProducts', { lifecyclePolicy }))).toEqual(['configuration_field_not_allowed']);
  });

  it('requires the route code and a selector of one Customer Group exactly on the membership route', () => {
    expect(codes(request('customerGroupsBatch', { routeCode: 'VIP' }))).toEqual(['route_code_invalid']);
    expect(codes(request('customerGroupCustomersBatch', {}, ['routeCode']))).toEqual(['route_code_invalid']);
    expect(codes(withConfiguration('customerGroupCustomersBatch', {}, ['selector']))).toEqual(['selector_invalid']);
    const otherRoute = {
      ...selector,
      source: { ...selector.source, route: { integrationRouteId: peerRouteId, tenantId } },
    };
    expect(codes(withConfiguration('customerGroupCustomersBatch', { selector: otherRoute }))).toEqual([
      'selector_invalid',
    ]);
    const priceGroup: NonNullable<EncodedConfiguration['selector']> = { ...selector, kind: 'PRICE_GROUP' };
    expect(codes(withConfiguration('customerGroupCustomersBatch', { selector: priceGroup }))).toEqual([
      'selector_invalid',
    ]);
  });

  it('refuses an operation outside the route inventory and one read from the wrong item', () => {
    expect(
      codes(
        withConfiguration('productsBatch', {
          items: [item('PRODUCT', [createProduct, productPage]), item('PRICE', [definePrice])],
        }),
      ),
    ).toEqual(['operation_not_in_route_inventory']);
    expect(
      codes(
        withConfiguration('productsBatch', {
          items: [item('PRODUCT', [createProduct, createVariant]), item('PRICE', [definePrice])],
        }),
      ),
    ).toEqual(['operation_entity_kind_mismatch']);
    expect(
      codes(
        withConfiguration('customersBatch', {
          items: [item('CUSTOMER', [createParty]), item('PERSON', [retailProfile])],
        }),
      ),
    ).toEqual(['operation_entity_kind_mismatch']);
  });

  it('refuses a route without an operation every request needs, and a write route without an owner write', () => {
    expect(
      codes(
        withConfiguration('productsBatch', { items: [item('VARIANT', [createVariant]), item('PRICE', [definePrice])] }),
      ),
    ).toEqual(['required_operation_missing']);
    expect(
      codes(
        withConfiguration('priceListPricesBatch', { items: [item('PRICE', [associations])] }, [
          'priceSource',
          'pricingSourceSystem',
        ]),
      ),
    ).toEqual(['required_operation_missing']);
  });

  it('names the price source and source system exactly when the route writes prices', () => {
    expect(codes(withConfiguration('productsBatch', {}, ['priceSource']))).toEqual(['price_source_mismatch']);
    expect(codes(withConfiguration('productsBatch', { items: [item('PRODUCT', [createProduct])] }))).toEqual([
      'price_source_mismatch',
    ]);
    expect(
      codes(
        withConfiguration('productsBatch', { items: [item('PRODUCT', [createProduct])] }, [
          'priceSource',
          'pricingSourceSystem',
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps the routes of one company off a Tenant-only route', () => {
    for (const routeKey of ['adminCustomers', 'adminRegions', 'customersBatch'] as const) {
      expect([routeKey, codes(request(routeKey, {}, ['legalEntityId']))]).toEqual([
        routeKey,
        ['company_scope_required'],
      ]);
    }
  });

  it('requires a customer groups route to enroll the Group definition read the Shell admits through, for a company', () => {
    expect(
      requestRefusals(withConfiguration('customerGroupsBatch', { items: [item('CUSTOMER_GROUP', [createGroup])] })),
    ).toEqual([
      'required_operation_missing: customerGroupsBatch cannot serve a request without commerce.customer-context.api.customer-group-definition-source@1',
    ]);
    expect(requestRefusals(request('customerGroupsBatch'))).toEqual([]);
    // Either write is enough beside the read, as the Shell and the planner serve both: an update-only route is enrolled.
    expect(
      requestRefusals(
        withConfiguration('customerGroupsBatch', {
          items: [item('CUSTOMER_GROUP', [updateGroup, groupDefinitionSource])],
        }),
      ),
    ).toEqual([]);
    expect(
      requestRefusals(
        withConfiguration('customerGroupsBatch', { items: [item('CUSTOMER_GROUP', [groupDefinitionSource])] }),
      ),
    ).toEqual(['required_operation_missing: customerGroupsBatch admits writes and enrolls no owner write']);
    expect(requestRefusals(request('customerGroupsBatch', {}, ['legalEntityId']))).toEqual([
      'company_scope_required: customerGroupsBatch reads or writes the data of one company and cannot be enrolled on a Tenant-only route',
    ]);
  });

  it('requires a customers route to enroll a complete person or organization plan', () => {
    expect(codes(withConfiguration('customersBatch', { items: [item('CUSTOMER', [createParty])] }))).toEqual([
      'required_operation_missing',
    ]);
    expect(codes(withConfiguration('customersBatch', { items: [item('CUSTOMER', [createParty, onboard])] }))).toEqual([
      'required_operation_missing',
    ]);
    expect(
      codes(
        withConfiguration('customersBatch', {
          items: [item('CUSTOMER', [createParty, onboard, counterpartyProfile])],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses mixed source identities and a write route without a lifecycle policy', () => {
    expect(
      codes(
        withConfiguration('productsBatch', {
          items: [
            item('PRODUCT', [createProduct], 'OTHER'),
            item('VARIANT', [createVariant]),
            item('PRICE', [definePrice]),
          ],
        }),
      ),
    ).toEqual(['source_identity_mixed']);
    expect(codes(request('customerGroupsBatch', {}, ['lifecyclePolicy']))).toEqual(['lifecycle_policy_required']);
  });

  it('rejects a request with fields the schema does not know', () => {
    const decoded = Schema.decodeUnknownResult(SymmyRouteEnrollmentRequestSchema, { onExcessProperty: 'error' })({
      ...Schema.encodeSync(SymmyRouteEnrollmentRequestSchema)(request('productsBatch')),
      active: false,
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it('names a route for a deactivation by the reference fields of its request alone', () => {
    const decodeReference = Schema.decodeUnknownResult(SymmyRouteReferenceSchema, { onExcessProperty: 'error' });
    const encoded = Schema.encodeSync(SymmyRouteEnrollmentRequestSchema)(request('customerGroupCustomersBatch'));
    const reference = without(encoded, ['configuration', 'lifecyclePolicy', 'mappingVersion', 'routeRevision']);
    expect(new Set(Object.keys(reference))).toEqual(new Set(Object.keys(SymmyRouteReferenceSchema.fields)));
    expect(Result.isSuccess(decodeReference(reference))).toBe(true);
    expect(Result.isFailure(decodeReference({ ...reference, routeRevision: encoded.routeRevision }))).toBe(true);
  });
});

describe('Symmy route state refusals', () => {
  it('requires the retention configuration to name the lifecycle policy for this route exactly once', () => {
    const policy = Schema.decodeUnknownSync(SymmyJobRetentionPolicySchema)({
      ...lifecyclePolicy,
      governanceLegalEntityId: legalEntityId,
      retentionMs: 86_400_000,
      routeId,
      targetLegalEntityId: legalEntityId,
      tenantId,
    });
    const enrollment = request('productsBatch');
    expect(symmyRetentionRefusals(enrollment, [policy])).toEqual([]);
    for (const configured of [[], [policy, policy], [{ ...policy, revision: 'r2' }]]) {
      expect(symmyRetentionRefusals(enrollment, configured).map(({ code }) => code)).toEqual([
        'lifecycle_policy_not_configured',
      ]);
    }
  });

  it('refuses an inactive module, an inactive company and an ineligible integration principal', () => {
    const facts = {
      activeModules: new Set(['integration.symmy']),
      companyActive: true,
      moduleKeys: ['commerce.catalog', 'integration.symmy'],
      principalIneligible: Option.none<string>(),
    };
    expect(symmyCoreRefusals(facts).map(({ code }) => code)).toEqual(['module_not_active']);
    expect(
      symmyCoreRefusals({ ...facts, activeModules: new Set(facts.moduleKeys), companyActive: false }).map(
        ({ code }) => code,
      ),
    ).toEqual(['company_not_active']);
    expect(
      symmyCoreRefusals({
        ...facts,
        activeModules: new Set(facts.moduleKeys),
        principalIneligible: Option.some('inactive'),
      }),
    ).toEqual([{ code: 'integration_principal_not_active', detail: 'The integration principal is inactive' }]);
  });

  it('compares the logical source of the routes of one source, field by field', () => {
    const products = withConfiguration('productsBatch', { sourceRouteId });
    const read = (configuration: EncodedConfiguration) =>
      storedRow(request('adminProducts', { configuration, routeId: peerRouteId }));
    const matching = read({ items: [item('PRODUCT', [productPage])], sourceRouteId });
    expect(symmyRelatedRouteRefusals(products, inventoryOf('productsBatch'), [matching])).toEqual({
      peers: [{ routeId: peerRouteId, routeKey: 'adminProducts' }],
      refusals: [],
    });
    const otherRoute = read({ items: [item('PRODUCT', [productPage])] });
    expect(
      symmyRelatedRouteRefusals(products, inventoryOf('productsBatch'), [otherRoute]).refusals.map(({ code }) => code),
    ).toEqual(['source_identity_differs_from_counterpart']);
    const customers = withConfiguration('customersBatch', { sourceRouteId });
    const otherCompany = storedRow(
      request('adminCustomers', {
        configuration: { items: [item('CUSTOMER', [customerPage])], sourceRouteId },
        legalEntityId: peerRouteId,
        routeId: peerRouteId,
      }),
    );
    expect(
      symmyRelatedRouteRefusals(customers, inventoryOf('customersBatch'), [otherCompany]).refusals.map(
        ({ detail }) => detail,
      ),
    ).toEqual([`Route ${peerRouteId} (adminCustomers) of the same source names another legalEntityId`]);
    const customerRead = storedRow(
      request('adminCustomers', {
        configuration: { items: [item('CUSTOMER', [customerPage])], sourceRouteId },
        routeId: peerRouteId,
      }),
      { mappingVersion: 'map-v2' },
    );
    expect(
      symmyRelatedRouteRefusals(customers, inventoryOf('customersBatch'), [customerRead]).refusals.map(
        ({ detail }) => detail,
      ),
    ).toEqual([`Route ${peerRouteId} (adminCustomers) of the same source names another sourceMappingVersion`]);
    expect(
      symmyRelatedRouteRefusals(customers, inventoryOf('customersBatch'), [
        { ...customerRead, fixturePlan: null },
      ]).refusals.map(({ code }) => code),
    ).toEqual(['source_identity_differs_from_counterpart']);
  });

  it('compares a membership route with the group route through the source its selector names', () => {
    const membership = request('customerGroupCustomersBatch');
    const group = (configuration: EncodedConfiguration) =>
      storedRow(request('customerGroupsBatch', { configuration, routeId: peerRouteId }));
    const sameSource = group({ items: [item('CUSTOMER_GROUP', [createGroup])], sourceRouteId });
    expect(
      symmyRelatedRouteRefusals(membership, inventoryOf('customerGroupCustomersBatch'), [sameSource]).refusals,
    ).toEqual([]);
    const otherIssuer = group({ items: [item('CUSTOMER_GROUP', [createGroup], 'OTHER')], sourceRouteId });
    expect(
      symmyRelatedRouteRefusals(membership, inventoryOf('customerGroupCustomersBatch'), [otherIssuer]).refusals.map(
        ({ code }) => code,
      ),
    ).toEqual(['source_identity_differs_from_counterpart']);
  });

  it('refuses a second active route that answers the same route lookup', () => {
    const products = request('productsBatch');
    const otherCompany = storedRow(products, { legalEntityId: null, routeId: peerRouteId });
    expect(
      symmyRelatedRouteRefusals(products, inventoryOf('productsBatch'), [otherCompany]).refusals.map(
        ({ code }) => code,
      ),
    ).toEqual(['route_selector_ambiguous']);
    expect(symmyRelatedRouteRefusals(products, inventoryOf('productsBatch'), [storedRow(products)]).refusals).toEqual(
      [],
    );
    // Another route id of the same company and code is the enrolled route the write decision refuses to rebind.
    const sameCompany = storedRow(products, { routeId: peerRouteId });
    expect(symmyRelatedRouteRefusals(products, inventoryOf('productsBatch'), [sameCompany]).refusals).toEqual([]);
    const membership = request('customerGroupCustomersBatch');
    const sameGroup = storedRow(membership, { routeCode: 'OTHER', routeId: peerRouteId });
    expect(
      symmyRelatedRouteRefusals(membership, inventoryOf('customerGroupCustomersBatch'), [sameGroup]).refusals.map(
        ({ code }) => code,
      ),
    ).toEqual(['route_selector_ambiguous']);
  });

  it('names outstanding jobs, the retention way to resolve a blocked one, and unerased synchronous admissions', () => {
    const outstanding = Schema.decodeUnknownSync(SymmyOutstandingWorkSchema);
    expect(symmyOutstandingRefusals(outstanding({ admissions: [], jobs: [], listedAll: true }))).toEqual([]);
    const refusals = symmyOutstandingRefusals(
      outstanding({
        admissions: [peerRouteId],
        jobs: [
          { jobId: routeId, state: 'indeterminate' },
          { jobId: groupId, state: 'blocked' },
        ],
        listedAll: true,
      }),
    );
    expect(refusals.map(({ code }) => code)).toEqual(['outstanding_work', 'outstanding_work', 'outstanding_work']);
    expect(refusals[0]?.detail).toContain(`${routeId} (indeterminate)`);
    expect(refusals[1]?.detail).toContain('integration.symmy.execute-symmy-retention');
    expect(refusals[1]?.detail).toContain(groupId);
    expect(refusals[2]?.detail).toContain(peerRouteId);
    expect(
      symmyOutstandingRefusals(
        outstanding({ admissions: [], jobs: [{ jobId: routeId, state: 'planned' }], listedAll: false }),
      ).map(({ detail }) => detail),
    ).toEqual([`Settle these jobs first: ${routeId} (planned)`, 'The route has more outstanding work than is listed']);
  });

  it('keeps the group route and the membership route of one source in one company', () => {
    const membership = request('customerGroupCustomersBatch');
    const groupIn = (company: string) =>
      storedRow(
        request('customerGroupsBatch', {
          configuration: { items: [item('CUSTOMER_GROUP', [createGroup])], sourceRouteId },
          legalEntityId: company,
          routeId: peerRouteId,
        }),
      );
    const peers = (group: RouteRow) =>
      symmyRelatedRouteRefusals(membership, inventoryOf('customerGroupCustomersBatch'), [group]).refusals.map(
        ({ detail }) => detail,
      );
    expect(peers(groupIn(legalEntityId))).toEqual([]);
    expect(peers(groupIn(unitRef.resourceId))).toEqual([
      `Route ${peerRouteId} (customerGroupsBatch) of the same source names another legalEntityId`,
    ]);
  });

  it('requires the active priceLists route of its company and its price reads of a prices route that revises, both ways', () => {
    const revising = withConfiguration('priceListPricesBatch', { sourceRouteId });
    const priceReads: readonly [Operation, ...Operation[]] = [
      associations,
      groupDefinition,
      priceSchedule,
      groupSourcePrices,
    ];
    const listsOf = (
      operations: readonly [Operation, ...Operation[]],
      company: Partial<EncodedRequest>,
      changes: Partial<EncodedRequest> = {},
    ) =>
      request('priceLists', {
        configuration: { items: [item('PRICE_GROUP', operations)], sourceRouteId },
        ...company,
        ...changes,
      });
    const company = { legalEntityId };
    const lists = (operations: readonly [Operation, ...Operation[]], listsCompany: Partial<EncodedRequest>) =>
      storedRow(listsOf(operations, listsCompany, { routeId: peerRouteId }));
    expect(relatedRefusals(revising, [])).toEqual([
      'price_revision_reads_missing: A REVISE price is read through the active priceLists route of this principal, and none is enrolled',
    ]);
    const withoutPrices = lists([associations, groupDefinition], company);
    expect(relatedRefusals(revising, [withoutPrices])).toEqual([
      `price_revision_reads_missing: Route ${peerRouteId} (priceLists) does not enroll commerce.pricing.api.price-schedule@1, which a REVISE price reads`,
      `price_revision_reads_missing: Route ${peerRouteId} (priceLists) does not enroll commerce.pricing.api.price-group-source-prices@1, which a REVISE price reads`,
    ]);
    expect(relatedRefusals(revising, [lists(priceReads, company)])).toEqual([]);
    // The REVISE reads the prices of the priceLists route's company, so a Tenant-only one or another company's is refused.
    expect(relatedRefusals(revising, [lists(priceReads, {})])).toEqual([
      `price_revision_company_differs: Route ${peerRouteId} (priceLists) reads the prices of company none, not of ${legalEntityId}, which this route revises`,
    ]);
    expect(relatedRefusals(revising, [lists(priceReads, { legalEntityId: otherLegalEntityId })])).toEqual([
      `price_revision_company_differs: Route ${peerRouteId} (priceLists) reads the prices of company ${otherLegalEntityId}, not of ${legalEntityId}, which this route revises`,
    ]);
    const tenantOnly = request(
      'priceListPricesBatch',
      { configuration: { ...valid.priceListPricesBatch().configuration, sourceRouteId } },
      ['legalEntityId'],
    );
    expect(relatedRefusals(tenantOnly, [lists(priceReads, {})])).toEqual([
      'company_scope_required: A REVISE price is read for one company, which this prices route does not name',
    ]);
    expect(
      relatedRefusals(
        withConfiguration('priceListPricesBatch', { items: [item('PRICE', [definePrice])], sourceRouteId }),
        [],
      ),
    ).toEqual([]);
    // A priceLists route keeps both reads, in the company of every prices route of the principal that revises.
    const revisingRow = storedRow(
      request('priceListPricesBatch', {
        configuration: { ...valid.priceListPricesBatch().configuration, sourceRouteId },
        routeId: peerRouteId,
      }),
    );
    expect(
      relatedRefusals(listsOf([associations, groupDefinition], company), [revisingRow]).map(
        (line) => line.split(':')[0],
      ),
    ).toEqual(['price_revision_reads_missing', 'price_revision_reads_missing']);
    expect(relatedRefusals(listsOf(priceReads, company), [revisingRow])).toEqual([]);
    expect(relatedRefusals(listsOf(priceReads, {}), [revisingRow])).toEqual([
      `price_revision_company_differs: Route ${peerRouteId} (priceListPricesBatch) revises the prices of company ${legalEntityId}, which this route, of none, does not read`,
    ]);
  });
});

describe('Symmy route write decisions', () => {
  it('inserts a new route and leaves an exact replay, a retried replacement at any token included, unchanged', () => {
    for (const routeKey of ['productsBatch', 'customerGroupCustomersBatch'] as const) {
      const enrollment = request(routeKey);
      expect(decided(enrollment, {})).toEqual({ kind: 'insert' });
      const stored = storedRow(enrollment, { changeToken: 2 });
      expect(decided(enrollment, { byRouteId: stored, bySelector: stored })).toEqual({ kind: 'unchanged' });
      expect(decided(enrollment, { byRouteId: stored, bySelector: stored }, replaceAt(1))).toEqual({
        kind: 'unchanged',
      });
    }
  });

  it('refuses drift unless a replacement at the current change token to a new revision is asked for', () => {
    const enrollment = request('productsBatch');
    const stored = storedRow(enrollment, { changeToken: 4, routeRevision: 'route-v0' });
    expect(refusalCodes(decided(enrollment, { byRouteId: stored, bySelector: stored }))).toEqual(['route_drift']);
    expect(decided(enrollment, { byRouteId: stored, bySelector: stored }, replaceAt(4))).toEqual({
      changed: ['routeRevision'],
      kind: 'replace',
      previous: { changeToken: 4, routeRevision: 'route-v0' },
    });
    const sameRevision = storedRow(enrollment, { mappingVersion: 'map-v0' });
    expect(
      refusalCodes(decided(enrollment, { byRouteId: sameRevision, bySelector: sameRevision }, replaceAt(1))),
    ).toEqual(['revision_not_advanced']);
    const inactive = storedRow(enrollment, { active: false });
    expect(refusalCodes(decided(enrollment, { byRouteId: inactive, bySelector: inactive }))).toEqual(['route_drift']);
  });

  it('refuses a replacement prepared before the route was stopped, at the revision it still carries', () => {
    // Prepared at token 1, revision route-v0; the route was then deactivated, which keeps route-v0 and replaces the token.
    const enrollment = request('productsBatch');
    const running = storedRow(enrollment, { routeRevision: 'route-v0' });
    expect(decided(enrollment, { byRouteId: running, bySelector: running }, replaceAt(1))).toMatchObject({
      kind: 'replace',
    });
    const stopped = storedRow(enrollment, { active: false, changeToken: 2, routeRevision: 'route-v0' });
    expect(refusalCodes(decided(enrollment, { byRouteId: stopped, bySelector: stopped }, replaceAt(1)))).toEqual([
      'change_token_not_current',
    ]);
    expect(decided(enrollment, { byRouteId: stopped, bySelector: stopped }, replaceAt(2))).toMatchObject({
      changed: ['active', 'routeRevision'],
      kind: 'replace',
    });
  });

  it('refuses a stale replacement after the route went back to the configuration it was prepared against', () => {
    // A (token 1) was replaced by B (token 2), then B by A again (token 3): retrying A -> B at token 1 writes nothing.
    const a = request('productsBatch', { mappingVersion: 'map-a', routeRevision: 'route-a' });
    const b = request('productsBatch', { mappingVersion: 'map-b', routeRevision: 'route-b' });
    const atA = storedRow(a);
    expect(decided(b, { byRouteId: atA, bySelector: atA }, replaceAt(1))).toMatchObject({ kind: 'replace' });
    const backAtA = storedRow(a, { changeToken: 3 });
    expect(refusalCodes(decided(b, { byRouteId: backAtA, bySelector: backAtA }, replaceAt(1)))).toEqual([
      'change_token_not_current',
    ]);
    expect(refusalCodes(stopAt(a, 1, backAtA))).toEqual(['change_token_not_current']);
  });

  it('deactivates a route only at its current change token, once, and only when it is enrolled', () => {
    const enrollment = request('productsBatch');
    const stored = storedRow(enrollment, { changeToken: 5 });
    expect(stopAt(enrollment, 5, stored)).toEqual({ kind: 'deactivate', route: stored });
    expect(refusalCodes(stopAt(enrollment, 4, stored))).toEqual(['change_token_not_current']);
    const inactive = storedRow(enrollment, { active: false, changeToken: 6 });
    expect(stopAt(enrollment, 5, inactive)).toEqual({ kind: 'unchanged', route: inactive });
    expect(refusalCodes(stopAt(enrollment, 1))).toEqual(['route_not_enrolled']);
  });

  it('never rebinds a route id or a selector to another route', () => {
    const enrollment = request('productsBatch');
    const other = storedRow(enrollment, { routeId: peerRouteId });
    expect(refusalCodes(decided(enrollment, { bySelector: other }, replaceAt(1)))).toEqual(['route_id_conflict']);
    expect(refusalCodes(stopAt(enrollment, 1, other))).toEqual(['route_id_conflict']);
    const elsewhere = storedRow(enrollment, { routeKey: 'adminProducts' });
    expect(refusalCodes(decided(enrollment, { byRouteId: elsewhere }))).toEqual(['route_id_conflict']);
  });

  it('locks every enrollment of one Tenant, principal and source on one key, whatever the company', () => {
    const products = request('productsBatch');
    const key = symmyRouteEnrollmentLockKey(products);
    expect(symmyRouteEnrollmentLockKey(request('productsBatch', { legalEntityId: peerRouteId }))).toBe(key);
    expect(symmyRouteEnrollmentLockKey(request('adminProducts'))).toBe(key);
    expect(symmyRouteEnrollmentLockKey(request('productsBatch', { principalId: peerRouteId }))).not.toBe(key);
    expect(symmyRouteEnrollmentLockKey(request('customersBatch'))).not.toBe(key);
    expect(symmyRouteEnrollmentLockKey(request('customerGroupCustomersBatch'))).toBe(
      symmyRouteEnrollmentLockKey(request('customerGroupsBatch')),
    );
    expect(symmyRouteEnrollmentLockKey(request('adminRegions'))).toBe(
      `symmy-route-enrollment:${tenantId}:${principalId}:adminRegions`,
    );
  });
});

const prerequisitesOf = (routeKey: Enrollable) =>
  symmyRuntimePrerequisites(request(routeKey)).map(({ checked, configuration }) => `${configuration}:${checked}`);

describe('Symmy route runtime prerequisites', () => {
  it('names the Shell and Symmy configuration a route needs and what a sender observes without it', () => {
    expect(prerequisitesOf('adminRegions')).toEqual(['ONTOS_SYMMY_REGIONS_PROJECTION:not_checked']);
    expect(prerequisitesOf('priceLists')).toEqual(['ONTOS_SYMMY_PRICE_READ_SOURCES:not_checked']);
    expect(prerequisitesOf('priceListPricesBatch')).toEqual([
      'ONTOS_SYMMY_PRICE_READ_SOURCES:not_checked',
      'ONTOS_SYMMY_JOB_RETENTION_POLICIES:operator_copy_only',
    ]);
    expect(prerequisitesOf('productsBatch')).toEqual(['ONTOS_SYMMY_JOB_RETENTION_POLICIES:operator_copy_only']);
    expect(prerequisitesOf('adminProducts')).toEqual([]);
    for (const prerequisite of symmyRuntimePrerequisites(request('adminRegions'))) {
      expect(prerequisite.whenMissing).toContain('projection_not_configured');
    }
  });
});
