import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountApplicationTargetSchema,
  PricingDiscountContributionSchema,
  PricingDiscountTypeSchema,
} from '../../src/domain/discount.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const productUnitId = '55555555-5555-4555-8555-555555555555';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef(productId, 'commerce.catalog.product');
const variantRef = catalogRef(variantId, 'commerce.catalog.variant');
const productUnitRef = catalogRef(productUnitId, 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };
const catalogEvidence = {
  assessedAt: '2026-09-27T09:59:59.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: '99999999-9999-4999-8999-999999999999',
    observedAt: '2026-09-27T09:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const line = {
  catalog: {
    completeness: {
      observedAt: '2026-09-27T09:59:59.000Z',
      ownerRevision: 'catalog-quantity:17',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
    },
    divisible: false,
    equivalentSelectionKey: 'catalog-selection:exact',
    evidence: catalogEvidence,
    hierarchyRevision: 'catalog-hierarchy:9',
    ownerRevision: 'catalog-quantity:17',
    quantity: {
      changed: false,
      notice: null,
      requested: '2',
      resulting: '2',
      rounding: 'HALF_UP' as const,
      status: 'VALID' as const,
      step: '1',
      targetId: variantId,
      tenantId,
      unitId: productUnitId,
      unitRuleRevision: 7,
    },
    quantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: variantRef,
      unitRef: productUnitRef,
      unitRuleRevision: 7,
    },
    selection,
    status: 'READY' as const,
    unitRef: productUnitRef,
  },
  occurrenceId: 'demand-occurrence-1',
  pricingBasis: { quantity: '1', unitRef: productUnitRef },
};
const decision = {
  commercialScope: {
    channelId: 'B2B' as const,
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  lines: [line],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-27T10:00:00.000Z',
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:41',
      decisionRevision: 'commerce-access-decision-revision:41',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:41',
      guestSessionRef: 'guest-session:41',
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:41',
      decisionRevision: 'commerce-settings-decision-revision:41',
    },
    contextRef: 'commerce-purchasing-context:41',
    contextRevision: 'customer-context:41',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:41',
      resolutionRevision: 'purchase-currency-resolution-revision:41',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:41',
      guestSessionRef: 'guest-session:41',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
};

const catalogAudience = { kind: 'CATALOG_PATH' as const, selection };
const priceGroupAudience = {
  kind: 'PRICE_GROUP' as const,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'pricing.price-group-catalog.price-group' as const,
    tenantId,
  },
};
const counterpartyAudience = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
};
const percentage = { kind: 'PERCENTAGE' as const, level: '10' };
const fixed = {
  kind: 'FIXED_MONETARY_AMOUNT' as const,
  level: { amount: '100', currencyCode: 'CZK' },
};
const lineTarget = {
  decision,
  kind: 'VARIANT_LINE' as const,
  occurrenceId: line.occurrenceId,
};
const wholePurchaseTarget = { decision, kind: 'WHOLE_PURCHASE' as const };

const decodeType = Schema.decodeUnknownSync(PricingDiscountTypeSchema, { onExcessProperty: 'error' });
const decodeTarget = Schema.decodeUnknownSync(PricingDiscountApplicationTargetSchema, {
  onExcessProperty: 'error',
});
const decodeContribution = Schema.decodeUnknownSync(PricingDiscountContributionSchema, {
  onExcessProperty: 'error',
});

describe('Pricing-owned Discount type contract', () => {
  it('accepts exactly the Launch family, audience, scope, and effect matrix', () => {
    const supported = [
      { audience: catalogAudience, effect: percentage, family: 'CATALOG_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: catalogAudience, effect: fixed, family: 'CATALOG_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: priceGroupAudience, effect: percentage, family: 'CONTRACTUAL_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: priceGroupAudience, effect: fixed, family: 'CONTRACTUAL_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: counterpartyAudience, effect: percentage, family: 'CONTRACTUAL_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: counterpartyAudience, effect: fixed, family: 'CONTRACTUAL_DISCOUNT', scope: 'VARIANT_LINE' },
      {
        audience: counterpartyAudience,
        effect: fixed,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'WHOLE_PURCHASE',
      },
    ] as const;

    expect(supported.map((candidate) => decodeType(candidate))).toEqual(supported);
  });

  it('rejects unsupported family/audience/scope/effect combinations', () => {
    const unsupported = [
      { audience: priceGroupAudience, effect: fixed, family: 'CATALOG_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: catalogAudience, effect: fixed, family: 'CONTRACTUAL_DISCOUNT', scope: 'VARIANT_LINE' },
      { audience: catalogAudience, effect: fixed, family: 'CATALOG_DISCOUNT', scope: 'WHOLE_PURCHASE' },
      { audience: priceGroupAudience, effect: fixed, family: 'CONTRACTUAL_DISCOUNT', scope: 'WHOLE_PURCHASE' },
      {
        audience: counterpartyAudience,
        effect: percentage,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'WHOLE_PURCHASE',
      },
      {
        audience: counterpartyAudience,
        effect: { kind: 'FIXED_PER_UNIT', level: { amount: '1', currencyCode: 'CZK' } },
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
      },
      { audience: counterpartyAudience, effect: fixed, family: 'PROMOTION', scope: 'VARIANT_LINE' },
    ];

    for (const candidate of unsupported) {
      expect(() => decodeType(candidate)).toThrow();
    }
  });

  it('keeps configured levels non-negative, bounds percentages, and preserves explicit zero', () => {
    for (const level of ['0', '0.0', '100', '100.00']) {
      expect(
        decodeType({
          audience: counterpartyAudience,
          effect: { kind: 'PERCENTAGE', level },
          family: 'CONTRACTUAL_DISCOUNT',
          scope: 'VARIANT_LINE',
        }).effect,
      ).toEqual({ kind: 'PERCENTAGE', level });
    }
    for (const level of ['-1', '100.01']) {
      expect(() =>
        decodeType({
          audience: counterpartyAudience,
          effect: { kind: 'PERCENTAGE', level },
          family: 'CONTRACTUAL_DISCOUNT',
          scope: 'VARIANT_LINE',
        }),
      ).toThrow();
    }
    expect(
      decodeType({
        audience: counterpartyAudience,
        effect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '0', currencyCode: 'CZK' } },
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
      }).effect,
    ).toEqual({ kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '0', currencyCode: 'CZK' } });
    expect(() =>
      decodeType({
        audience: counterpartyAudience,
        effect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '-0.01', currencyCode: 'CZK' } },
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
      }),
    ).toThrow();
  });

  it('binds line scope to one concrete Variant line and whole scope to the exact decision', () => {
    expect(decodeTarget(lineTarget)).toEqual(lineTarget);
    expect(decodeTarget(wholePurchaseTarget)).toEqual(wholePurchaseTarget);
    expect(() => decodeTarget({ ...lineTarget, occurrenceId: 'missing-occurrence' })).toThrow();

    const productOnlySelection = { productRef };
    expect(() =>
      decodeTarget({
        ...lineTarget,
        decision: {
          ...decision,
          lines: [{ ...line, catalog: { ...line.catalog, selection: productOnlySelection } }],
        },
      }),
    ).toThrow();
  });

  it('keeps configured level separate from a non-positive applied contribution and accepts zero', () => {
    const discountType = {
      audience: counterpartyAudience,
      effect: percentage,
      family: 'CONTRACTUAL_DISCOUNT' as const,
      scope: 'VARIANT_LINE' as const,
    };
    const contribution = {
      amount: { amount: '-100', currencyCode: 'CZK' },
      discountType,
      monetaryBoundary: 'PRE_TAX' as const,
      target: lineTarget,
    };

    expect(decodeContribution(contribution)).toEqual(contribution);
    expect(decodeContribution({ ...contribution, amount: { amount: '0', currencyCode: 'CZK' } }).amount.amount).toBe(
      '0',
    );
    expect(() => decodeContribution({ ...contribution, amount: { amount: '0.01', currencyCode: 'CZK' } })).toThrow();
  });

  it('requires target, audience, and fixed effect currency to match the exact decision', () => {
    const wholeType = {
      audience: counterpartyAudience,
      effect: fixed,
      family: 'CONTRACTUAL_DISCOUNT' as const,
      scope: 'WHOLE_PURCHASE' as const,
    };
    const contribution = {
      amount: { amount: '-100', currencyCode: 'CZK' },
      discountType: wholeType,
      monetaryBoundary: 'PRE_TAX' as const,
      target: wholePurchaseTarget,
    };
    expect(decodeContribution(contribution)).toEqual(contribution);
    expect(() => decodeContribution({ ...contribution, amount: { amount: '-100', currencyCode: 'EUR' } })).toThrow();
    expect(() =>
      decodeContribution({
        ...contribution,
        discountType: {
          ...wholeType,
          effect: { ...fixed, level: { amount: '100', currencyCode: 'EUR' } },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeContribution({
        ...contribution,
        discountType: {
          ...wholeType,
          audience: {
            ...counterpartyAudience,
            counterpartyRef: {
              ...counterpartyAudience.counterpartyRef,
              tenantId: '88888888-8888-4888-8888-888888888888',
            },
          },
        },
      }),
    ).toThrow();
  });

  it('rejects Storefront selectors, automated levels, and campaign ownership at the strict boundary', () => {
    expect(() =>
      decodeType({
        audience: counterpartyAudience,
        automatedLevel: 'GOLD',
        effect: percentage,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
      }),
    ).toThrow();
    expect(() =>
      decodeType({
        audience: counterpartyAudience,
        campaignRef: 'campaign:launch',
        effect: percentage,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
      }),
    ).toThrow();
    expect(() =>
      decodeType({
        audience: counterpartyAudience,
        effect: percentage,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'VARIANT_LINE',
        storefrontId: 'storefront:cz',
      }),
    ).toThrow();
  });
});
