import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountApplicationTargetSchema,
  PricingDiscountContributionSchema,
  PricingDiscountTypeSchema,
} from '../../src/domain/discount.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellingLegalEntityId = '22222222-2222-4222-8222-222222222222';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.product');
const firstVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const secondVariantRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant');
const unitRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.product-unit');

const selectionFor = (variantRef: typeof firstVariantRef) => ({ productRef, variantRef });

const catalogHandoffFor = (variantRef: typeof firstVariantRef) => {
  const selection = selectionFor(variantRef);
  return {
    completeness: {
      observedAt: '2026-09-27T09:59:59.000Z',
      ownerRevision: `catalog-quantity:${variantRef.resourceId}`,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog-quantity:${variantRef.resourceId}` },
    },
    divisible: false,
    equivalentSelectionKey: `catalog-selection:${variantRef.resourceId}`,
    evidence: {
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
        attestationId: `catalog-membership:${variantRef.resourceId}`,
        observedAt: '2026-09-27T09:59:59.000Z',
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        variant: { resourceRef: variantRef, revision: 2 },
      },
      purpose: 'PRICING' as const,
      selection,
      status: 'VALID' as const,
    },
    hierarchyRevision: 'catalog-hierarchy:1',
    ownerRevision: `catalog-quantity:${variantRef.resourceId}`,
    quantity: {
      changed: false,
      notice: null,
      requested: '1',
      resulting: '1',
      rounding: 'HALF_UP' as const,
      status: 'VALID' as const,
      step: '1',
      targetId: variantRef.resourceId,
      tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision: 1,
    },
    quantityBasis: {
      targetDivisibilityRevision: 1,
      targetRef: variantRef,
      unitRef,
      unitRuleRevision: 1,
    },
    selection,
    status: 'READY' as const,
    unitRef,
  };
};

const lineFor = (occurrenceId: string, variantRef: typeof firstVariantRef) => ({
  catalog: catalogHandoffFor(variantRef),
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});

const firstLine = lineFor('demand-occurrence:first', firstVariantRef);
const secondLine = lineFor('demand-occurrence:second', secondVariantRef);
const decisionFor = (channelId: 'B2C' | 'B2B' = 'B2B', currencyCode = 'CZK') => ({
  commercialScope: { channelId, marketId: 'cz-launch', sellingLegalEntityId },
  currencyCode,
  lines: [firstLine, secondLine],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-27T10:00:00.000Z',
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:770',
      decisionRevision: 'commerce-access-decision-revision:770',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:770',
      guestSessionRef: 'guest-session:770',
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:770',
      decisionRevision: 'commerce-settings-decision-revision:770',
    },
    contextRef: 'commerce-purchasing-context:770',
    contextRevision: 'customer-context:770',
    currencyResolution: {
      currencyCode,
      resolutionRef: 'purchase-currency-resolution:770',
      resolutionRevision: 'purchase-currency-resolution-revision:770',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:770',
      guestSessionRef: 'guest-session:770',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
});

const catalogAudience = { kind: 'CATALOG_PATH' as const, selection: selectionFor(firstVariantRef) };
const priceGroupAudience = {
  kind: 'PRICE_GROUP' as const,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'pricing.price-group-catalog.price-group' as const,
    tenantId,
  },
};
const counterpartyAudience = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
};
const percentage = { kind: 'PERCENTAGE' as const, level: '10' };
const fixedCzk = {
  kind: 'FIXED_MONETARY_AMOUNT' as const,
  level: { amount: '100', currencyCode: 'CZK' },
};

const decodeDiscountType = Schema.decodeUnknownSync(PricingDiscountTypeSchema, { onExcessProperty: 'error' });
const decodeTarget = Schema.decodeUnknownSync(PricingDiscountApplicationTargetSchema, {
  onExcessProperty: 'error',
});
const decodeContribution = Schema.decodeUnknownSync(PricingDiscountContributionSchema, {
  onExcessProperty: 'error',
});

describe('Issue #770 Pricing-owned Discount acceptance', () => {
  it('accepts all and only the seven Launch family, audience, scope, and effect combinations', () => {
    const audiences = [catalogAudience, priceGroupAudience, counterpartyAudience] as const;
    const effects = [percentage, fixedCzk] as const;
    const families = ['CATALOG_DISCOUNT', 'CONTRACTUAL_DISCOUNT'] as const;
    const scopes = ['VARIANT_LINE', 'WHOLE_PURCHASE'] as const;
    const accepted = new Set([
      'CATALOG_DISCOUNT/CATALOG_PATH/VARIANT_LINE/PERCENTAGE',
      'CATALOG_DISCOUNT/CATALOG_PATH/VARIANT_LINE/FIXED_MONETARY_AMOUNT',
      'CONTRACTUAL_DISCOUNT/PRICE_GROUP/VARIANT_LINE/PERCENTAGE',
      'CONTRACTUAL_DISCOUNT/PRICE_GROUP/VARIANT_LINE/FIXED_MONETARY_AMOUNT',
      'CONTRACTUAL_DISCOUNT/COUNTERPARTY/VARIANT_LINE/PERCENTAGE',
      'CONTRACTUAL_DISCOUNT/COUNTERPARTY/VARIANT_LINE/FIXED_MONETARY_AMOUNT',
      'CONTRACTUAL_DISCOUNT/COUNTERPARTY/WHOLE_PURCHASE/FIXED_MONETARY_AMOUNT',
    ]);

    let acceptedCount = 0;
    for (const family of families) {
      for (const audience of audiences) {
        for (const scope of scopes) {
          for (const effect of effects) {
            const key = `${family}/${audience.kind}/${scope}/${effect.kind}`;
            const candidate = { audience, effect, family, scope };
            if (accepted.has(key)) {
              expect(decodeDiscountType(candidate)).toEqual(candidate);
              acceptedCount += 1;
            } else {
              expect(() => decodeDiscountType(candidate)).toThrow();
            }
          }
        }
      }
    }
    expect(acceptedCount).toBe(7);
  });

  it('retains simultaneous Catalog, Price Group, and Counterparty line contributions as independent facts', () => {
    const target = {
      decision: decisionFor(),
      kind: 'VARIANT_LINE' as const,
      occurrenceId: firstLine.occurrenceId,
    };
    const contributions = [
      {
        amount: { amount: '-100', currencyCode: 'CZK' },
        discountType: {
          audience: catalogAudience,
          effect: percentage,
          family: 'CATALOG_DISCOUNT' as const,
          scope: 'VARIANT_LINE' as const,
        },
        monetaryBoundary: 'PRE_TAX' as const,
        target,
      },
      {
        amount: { amount: '-50', currencyCode: 'CZK' },
        discountType: {
          audience: priceGroupAudience,
          effect: { ...percentage, level: '5' },
          family: 'CONTRACTUAL_DISCOUNT' as const,
          scope: 'VARIANT_LINE' as const,
        },
        monetaryBoundary: 'PRE_TAX' as const,
        target,
      },
      {
        amount: { amount: '-30', currencyCode: 'CZK' },
        discountType: {
          audience: counterpartyAudience,
          effect: { ...percentage, level: '3' },
          family: 'CONTRACTUAL_DISCOUNT' as const,
          scope: 'VARIANT_LINE' as const,
        },
        monetaryBoundary: 'PRE_TAX' as const,
        target,
      },
    ];

    const decoded = contributions.map((contribution) => decodeContribution(contribution));
    expect(decoded).toHaveLength(3);
    expect(decoded.map(({ discountType }) => discountType.audience.kind)).toEqual([
      'CATALOG_PATH',
      'PRICE_GROUP',
      'COUNTERPARTY',
    ]);
    expect(decoded.map(({ amount }) => amount.amount)).toEqual(['-100', '-50', '-30']);
  });

  it('models fixed line effects once per stable line and whole-purchase fixed effects once per decision', () => {
    const decision = decisionFor();
    const lineDiscount = {
      audience: counterpartyAudience,
      effect: fixedCzk,
      family: 'CONTRACTUAL_DISCOUNT' as const,
      scope: 'VARIANT_LINE' as const,
    };
    const lineContributions = decision.lines.map(({ occurrenceId }) =>
      decodeContribution({
        amount: { amount: '-100', currencyCode: 'CZK' },
        discountType: lineDiscount,
        monetaryBoundary: 'PRE_TAX',
        target: { decision, kind: 'VARIANT_LINE', occurrenceId },
      }),
    );
    const wholeContribution = decodeContribution({
      amount: { amount: '-100', currencyCode: 'CZK' },
      discountType: {
        audience: counterpartyAudience,
        effect: fixedCzk,
        family: 'CONTRACTUAL_DISCOUNT',
        scope: 'WHOLE_PURCHASE',
      },
      monetaryBoundary: 'PRE_TAX',
      target: { decision, kind: 'WHOLE_PURCHASE' },
    });

    expect(lineContributions.map(({ target }) => target.kind)).toEqual(['VARIANT_LINE', 'VARIANT_LINE']);
    expect(lineContributions.map(({ target }) => ('occurrenceId' in target ? target.occurrenceId : null))).toEqual([
      firstLine.occurrenceId,
      secondLine.occurrenceId,
    ]);
    expect(wholeContribution.target.kind).toBe('WHOLE_PURCHASE');
    expect('occurrenceId' in wholeContribution.target).toBe(false);
  });

  it('accepts configured zero, rejects negative levels, and caps percentage at one hundred', () => {
    for (const effect of [
      { kind: 'PERCENTAGE' as const, level: '0' },
      { kind: 'PERCENTAGE' as const, level: '100' },
      { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '0', currencyCode: 'CZK' } },
    ]) {
      expect(
        decodeDiscountType({
          audience: counterpartyAudience,
          effect,
          family: 'CONTRACTUAL_DISCOUNT',
          scope: 'VARIANT_LINE',
        }).effect,
      ).toEqual(effect);
    }

    for (const effect of [
      { kind: 'PERCENTAGE', level: '-0.01' },
      { kind: 'PERCENTAGE', level: '100.01' },
      { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '-0.01', currencyCode: 'CZK' } },
    ]) {
      expect(() =>
        decodeDiscountType({
          audience: counterpartyAudience,
          effect,
          family: 'CONTRACTUAL_DISCOUNT',
          scope: 'VARIANT_LINE',
        }),
      ).toThrow();
    }
  });

  it('binds contributions to exact Variant, SLE, B2C or B2B, Market, native currency, and pricing basis', () => {
    for (const channelId of ['B2C', 'B2B'] as const) {
      const decision = decisionFor(channelId);
      const target = decodeTarget({ decision, kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId });
      expect(target.decision.commercialScope).toEqual({
        channelId,
        marketId: 'cz-launch',
        sellingLegalEntityId,
      });
      expect(target.decision.lines[0]?.catalog.selection).toEqual(selectionFor(firstVariantRef));
      expect(target.decision.lines[0]?.pricingBasis).toEqual({ quantity: '1', unitRef });
    }

    const contribution = {
      amount: { amount: '-10', currencyCode: 'CZK' },
      discountType: {
        audience: catalogAudience,
        effect: percentage,
        family: 'CATALOG_DISCOUNT' as const,
        scope: 'VARIANT_LINE' as const,
      },
      monetaryBoundary: 'PRE_TAX' as const,
      target: {
        decision: decisionFor(),
        kind: 'VARIANT_LINE' as const,
        occurrenceId: firstLine.occurrenceId,
      },
    };
    expect(decodeContribution(contribution)).toEqual(contribution);
    expect(() =>
      decodeContribution({
        ...contribution,
        discountType: {
          ...contribution.discountType,
          audience: { ...catalogAudience, selection: selectionFor(secondVariantRef) },
        },
      }),
    ).toThrow();
    expect(() => decodeContribution({ ...contribution, amount: { amount: '-10', currencyCode: 'EUR' } })).toThrow();
  });

  it('rejects Product runtime targets, inheritance, Storefront selection, and non-Pricing discount ownership', () => {
    const decision = decisionFor();
    const validType = {
      audience: counterpartyAudience,
      effect: percentage,
      family: 'CONTRACTUAL_DISCOUNT' as const,
      scope: 'VARIANT_LINE' as const,
    };

    for (const target of [
      { decision, kind: 'PRODUCT', productRef },
      { decision, inheritToFutureVariants: true, kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId },
      { decision, kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId, productBulkTarget: productRef },
      { decision, kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId, storefrontId: 'storefront:cz' },
    ]) {
      expect(() => decodeTarget(target)).toThrow();
    }

    for (const forbiddenMeaning of [
      { ...validType, family: 'PROMOTION' },
      { ...validType, family: 'LOYALTY_DISCOUNT' },
      { ...validType, loyaltyLevel: 'GOLD' },
      { ...validType, automatedLevel: 'BRONZE' },
      { ...validType, campaignRef: 'campaign:launch' },
      { ...validType, effect: { kind: 'FIXED_PER_UNIT', level: { amount: '5', currencyCode: 'CZK' } } },
    ]) {
      expect(() => decodeDiscountType(forbiddenMeaning)).toThrow();
    }
  });

  it('keeps currency contracts generalized without treating a Discount as activation evidence', () => {
    const eurDecision = decisionFor('B2C', 'EUR');
    const eurType = {
      audience: counterpartyAudience,
      effect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '10', currencyCode: 'EUR' } },
      family: 'CONTRACTUAL_DISCOUNT' as const,
      scope: 'VARIANT_LINE' as const,
    };
    expect(decodeDiscountType(eurType)).toEqual(eurType);
    expect(
      decodeContribution({
        amount: { amount: '-10', currencyCode: 'EUR' },
        discountType: eurType,
        monetaryBoundary: 'PRE_TAX',
        target: { decision: eurDecision, kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId },
      }).amount.currencyCode,
    ).toBe('EUR');
    expect(() => decodeDiscountType({ ...eurType, supportedCurrencies: ['EUR'] })).toThrow();
    expect(() =>
      decodeContribution({
        amount: { amount: '-10', currencyCode: 'EUR' },
        discountType: eurType,
        monetaryBoundary: 'PRE_TAX',
        target: { decision: decisionFor(), kind: 'VARIANT_LINE', occurrenceId: firstLine.occurrenceId },
      }),
    ).toThrow();
  });
});
