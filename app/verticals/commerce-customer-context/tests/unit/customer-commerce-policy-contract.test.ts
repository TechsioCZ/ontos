import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  assertCustomerCommercePolicyRevisionMeaningImmutable,
  CommerceQuantityPolicyCurrentFailureSchema,
  CommerceQuantityRuleRevisionSchema,
  CustomerCommercePolicyFieldIdSchema,
  CustomerCommercePolicyRevisionMeaningChangeSchema,
  CustomerCommercePolicyRevisionSchema,
  MarketBootstrapPolicyRevisionSchema,
  PaymentTermPolicyCurrentFailureSchema,
  PurchaseCurrencyPolicyCurrentFailureSchema,
  PurchaseCurrencyPolicyRevisionSchema,
  customerCommercePolicyFieldCatalog,
} from '../../shared/domain/customer-commerce-policy.ts';

const tenantId = '55555555-5555-4555-8555-555555555555';
const sellingLegalEntityId = '44444444-4444-4444-8444-444444444444';

const revisionBase = {
  actionInvocationId: '11111111-1111-4111-8111-111111111111',
  actorPrincipalId: '22222222-2222-4222-8222-222222222222',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  idempotencyKey: 'launch-policy-1',
  lifecycle: 'ACTIVE',
  reason: 'Approved launch policy',
  revisionId: '33333333-3333-4333-8333-333333333333',
  scope: {
    channelId: 'b2b',
    kind: 'CHANNEL_SELLER',
    sellingLegalEntityId,
  },
  tenantId,
} as const;

const catalogRef = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});

const quantityBasis = {
  targetDivisibilityRevision: 7,
  targetRef: catalogRef('commerce.catalog.variant', '55555555-5555-4555-8555-555555555555'),
  unitRef: catalogRef('commerce.catalog.product-unit', '66666666-6666-4666-8666-666666666666'),
  unitRuleRevision: 9,
};

const quantityRevision = (overrides: { readonly scope?: object; readonly value?: object } = {}) => ({
  ...revisionBase,
  field: 'COMMERCE_QUANTITY_RULE',
  scope: {
    channelId: 'b2b',
    commerceMarketId: 'cz-market',
    kind: 'MARKET_CHANNEL_SELLER',
    sellingLegalEntityId,
  },
  value: {
    basis: quantityBasis,
    constraintMode: 'REPLACEABLE_ENVELOPE',
    envelope: { kind: 'BOUNDED', maximum: null, minimum: '1.25', multiple: '0.25' },
    kind: 'COMMERCE_QUANTITY_RULE',
    selector: { kind: 'PRODUCT', productRef: catalogRef('commerce.catalog.product', 'product-1') },
  },
  ...overrides,
});

describe('Customer Commerce Policy field catalog', () => {
  it('contains exactly the four executable Launch field families with explicit composition semantics', () => {
    expect(customerCommercePolicyFieldCatalog.map(({ id }) => id)).toEqual([
      'MARKET_BOOTSTRAP',
      'PURCHASE_CURRENCY',
      'PAYMENT_TERM',
      'COMMERCE_QUANTITY_RULE',
    ]);
    expect(customerCommercePolicyFieldCatalog.map(({ composition }) => composition)).toEqual([
      'REPLACEABLE_DEFAULT',
      'REPLACEABLE_DEFAULT_WITH_NON_RELAXABLE_CONSTRAINTS',
      'REPLACEABLE_DEFAULT_WITH_NON_RELAXABLE_CONSTRAINTS',
      'REPLACEABLE_ENVELOPE_WITH_NON_RELAXABLE_CONSTRAINTS',
    ]);
  });

  it('rejects candidate inventory, monetary minimum order, and opaque OTHER fields', () => {
    const decode = Schema.decodeUnknownSync(CustomerCommercePolicyFieldIdSchema);

    expect(() => decode('CANDIDATE_INVENTORY')).toThrow();
    expect(() => decode('MONETARY_MINIMUM_ORDER')).toThrow();
    expect(() => decode('OTHER')).toThrow();
  });

  it('rejects opaque JSON and keeps defaults distinct from non-relaxable constraints', () => {
    const decode = Schema.decodeUnknownSync(CustomerCommercePolicyRevisionSchema);
    expect(() =>
      decode({
        ...revisionBase,
        field: 'PURCHASE_CURRENCY',
        value: { arbitrary: { expression: 'currency === CZK' } },
      }),
    ).toThrow();

    expect(
      decode({
        ...revisionBase,
        field: 'PURCHASE_CURRENCY',
        value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
      }).value.kind,
    ).toBe('DEFAULT_CURRENCY');
    expect(
      decode({
        ...revisionBase,
        field: 'PURCHASE_CURRENCY',
        revisionId: '33333333-3333-4333-8333-333333333334',
        value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
      }).value.kind,
    ).toBe('ALLOWED_CURRENCY_CONSTRAINT');
    expect(() =>
      decode({
        ...revisionBase,
        field: 'PURCHASE_CURRENCY',
        revisionId: '33333333-3333-4333-8333-333333333335',
        value: { enabled: true, kind: 'EXPLICIT_CURRENCY_CHOICE_POLICY' },
      }),
    ).toThrow();
  });

  it('closes each field family over only its accepted scope ranks', () => {
    const ordinary = {
      ...revisionBase,
      field: 'PURCHASE_CURRENCY',
      value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
    };
    expect(() =>
      Schema.decodeUnknownSync(PurchaseCurrencyPolicyRevisionSchema)({
        ...ordinary,
        scope: {
          channelId: 'b2b',
          kind: 'STOREFRONT_CHANNEL_SELLER',
          sellingLegalEntityId,
          storefrontId: 'storefront-1',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyRevisionSchema)({
        ...revisionBase,
        field: 'MARKET_BOOTSTRAP',
        scope: {
          channelId: 'b2b',
          commerceMarketId: 'cz-market',
          kind: 'MARKET_CHANNEL_SELLER',
          sellingLegalEntityId,
        },
        value: {
          defaultChannelId: 'b2b',
          defaultCommerceMarketId: 'cz-market',
          defaultSellingLegalEntityId: sellingLegalEntityId,
          kind: 'DEFAULT_MARKET_TUPLE',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CommerceQuantityRuleRevisionSchema)({
        ...quantityRevision(),
        scope: { kind: 'SELLER', sellingLegalEntityId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CommerceQuantityRuleRevisionSchema)({
        ...quantityRevision(),
        scope: {
          channelId: 'b2b',
          kind: 'STOREFRONT_CHANNEL_SELLER',
          sellingLegalEntityId,
          storefrontId: 'storefront-1',
        },
      }),
    ).toThrow();
  });

  it('requires UUID-backed revision identity and coherent Market bootstrap tuples', () => {
    expect(() =>
      Schema.decodeUnknownSync(PurchaseCurrencyPolicyRevisionSchema)({
        ...revisionBase,
        field: 'PURCHASE_CURRENCY',
        revisionId: 'not-a-uuid',
        value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
      }),
    ).toThrow();

    const bootstrap = {
      ...revisionBase,
      field: 'MARKET_BOOTSTRAP',
      value: {
        defaultChannelId: 'b2b',
        defaultCommerceMarketId: 'cz-market',
        defaultSellingLegalEntityId: sellingLegalEntityId,
        kind: 'DEFAULT_MARKET_TUPLE',
      },
    };
    expect(Schema.is(MarketBootstrapPolicyRevisionSchema)(bootstrap)).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyRevisionSchema)({
        ...bootstrap,
        value: {
          ...bootstrap.value,
          defaultSellingLegalEntityId: '44444444-4444-4444-8444-444444444445',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyRevisionSchema)({
        ...bootstrap,
        value: { ...bootstrap.value, defaultChannelId: 'different-channel' },
      }),
    ).toThrow();
    const storefrontScoped = {
      ...bootstrap,
      scope: {
        ...bootstrap.scope,
        kind: 'STOREFRONT_CHANNEL_SELLER',
        storefrontId: 'storefront-1',
      },
    };
    expect(Schema.is(MarketBootstrapPolicyRevisionSchema)(storefrontScoped)).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(MarketBootstrapPolicyRevisionSchema)({
        ...storefrontScoped,
        value: { ...storefrontScoped.value, defaultStorefrontId: 'storefront-1' },
      }),
    ).toThrow();
  });

  it('accepts complete owner-issued Catalog selectors and rejects raw or unsupported selectors', () => {
    const decode = Schema.decodeUnknownSync(CommerceQuantityRuleRevisionSchema);
    expect(decode(quantityRevision()).value.selector.kind).toBe('PRODUCT');

    expect(() =>
      decode(
        quantityRevision({
          value: {
            ...quantityRevision().value,
            selector: { kind: 'PRODUCT', productId: 'product-1' },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        quantityRevision({
          value: {
            ...quantityRevision().value,
            selector: { categoryRef: catalogRef('commerce.catalog.category', 'category-1'), kind: 'CATEGORY' },
          },
        }),
      ),
    ).toThrow();
  });

  it('uses exact positive decimal strings and an explicit owner-issued Quantity basis', () => {
    const decode = Schema.decodeUnknownSync(CommerceQuantityRuleRevisionSchema);
    expect(decode(quantityRevision()).value.envelope).toMatchObject({ minimum: '1.25', multiple: '0.25' });

    for (const minimum of [1.25, '0', '-1', '1e3']) {
      expect(() =>
        decode(
          quantityRevision({
            value: {
              ...quantityRevision().value,
              envelope: { kind: 'BOUNDED', maximum: null, minimum, multiple: null },
            },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      decode(
        quantityRevision({
          value: {
            ...quantityRevision().value,
            basis: {
              ...quantityBasis,
              unitRef: { ...quantityBasis.unitRef, tenantId: '66666666-6666-4666-8666-666666666666' },
            },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        quantityRevision({
          value: {
            ...quantityRevision().value,
            envelope: { kind: 'BOUNDED', maximum: '9.999', minimum: '10.0', multiple: null },
          },
        }),
      ),
    ).toThrow();
  });

  it('validates canonical timestamps and non-empty half-open periods at the schema boundary', () => {
    const decode = Schema.decodeUnknownSync(PurchaseCurrencyPolicyRevisionSchema);
    const revision = {
      ...revisionBase,
      field: 'PURCHASE_CURRENCY',
      value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
    };
    expect(() => decode({ ...revision, effectiveFrom: '2026-10-01' })).toThrow();
    expect(() => decode({ ...revision, effectiveTo: revision.effectiveFrom })).toThrow();
  });

  it('treats effective start, scope, and value as immutable revision meaning', () => {
    const original = Schema.decodeUnknownSync(PurchaseCurrencyPolicyRevisionSchema)({
      ...revisionBase,
      field: 'PURCHASE_CURRENCY',
      value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
    });

    const moved = Schema.decodeUnknownSync(PurchaseCurrencyPolicyRevisionSchema)({
      ...revisionBase,
      effectiveFrom: '2026-11-01T00:00:00.000Z',
      field: 'PURCHASE_CURRENCY',
      value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
    });
    const movedChange = assertCustomerCommercePolicyRevisionMeaningImmutable(original, moved);
    expect(Schema.is(CustomerCommercePolicyRevisionMeaningChangeSchema)(movedChange)).toBe(true);
    if (!Schema.is(CustomerCommercePolicyRevisionMeaningChangeSchema)(movedChange)) {
      throw new Error('expected a revision meaning change');
    }
    expect(movedChange.revisionId).toBe(original.revisionId);

    const valueChange = assertCustomerCommercePolicyRevisionMeaningImmutable(original, {
      ...original,
      value: { currencyCode: 'EUR', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
    });
    expect(Schema.is(CustomerCommercePolicyRevisionMeaningChangeSchema)(valueChange)).toBe(true);
    if (!Schema.is(CustomerCommercePolicyRevisionMeaningChangeSchema)(valueChange)) {
      throw new Error('expected a revision value change');
    }
    expect(valueChange.revisionId).toBe(original.revisionId);

    const periodChange = assertCustomerCommercePolicyRevisionMeaningImmutable(original, {
      ...original,
      effectiveTo: '2027-01-01T00:00:00.000Z',
    });
    expect(Schema.is(CustomerCommercePolicyRevisionMeaningChangeSchema)(periodChange)).toBe(true);
  });

  it('exposes field-specific missing, conflict, broken, and unverifiable outcomes', () => {
    expect(
      Schema.decodeUnknownSync(PurchaseCurrencyPolicyCurrentFailureSchema)('MISSING_PURCHASE_CURRENCY_POLICY'),
    ).toBe('MISSING_PURCHASE_CURRENCY_POLICY');
    expect(Schema.decodeUnknownSync(PaymentTermPolicyCurrentFailureSchema)('BROKEN_PAYMENT_TERM_POLICY')).toBe(
      'BROKEN_PAYMENT_TERM_POLICY',
    );
    expect(
      Schema.decodeUnknownSync(CommerceQuantityPolicyCurrentFailureSchema)('BROKEN_COMMERCE_QUANTITY_ASSIGNMENT'),
    ).toBe('BROKEN_COMMERCE_QUANTITY_ASSIGNMENT');
    expect(() =>
      Schema.decodeUnknownSync(PurchaseCurrencyPolicyCurrentFailureSchema)('BROKEN_PAYMENT_TERM_POLICY'),
    ).toThrow();
  });
});
