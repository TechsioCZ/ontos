import { PricingDiscountContributionSchema } from '@app/pricing-contracts/domain/discount';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountInterpretationRejected,
  interpretPricingDiscountContribution,
} from '../../src/services/discount-interpretation.service.ts';

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
const occurrenceId = 'demand-occurrence-1';
const line = {
  catalog: {
    completeness: {
      observedAt: '2026-09-27T09:59:59.000Z',
      ownerRevision: 'catalog-quantity:17',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
    },
    divisible: false,
    equivalentSelectionKey: 'catalog-selection:exact',
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
        attestationId: '99999999-9999-4999-8999-999999999999',
        observedAt: '2026-09-27T09:59:59.000Z',
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        variant: { resourceRef: variantRef, revision: 2 },
      },
      purpose: 'PRICING' as const,
      selection,
      status: 'VALID' as const,
    },
    hierarchyRevision: 'catalog-hierarchy:9',
    ownerRevision: 'catalog-quantity:17',
    quantity: {
      changed: false,
      notice: null,
      requested: '5',
      resulting: '5',
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
  occurrenceId,
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
const lineTarget = { decision, kind: 'VARIANT_LINE' as const, occurrenceId };
const wholePurchaseTarget = { decision, kind: 'WHOLE_PURCHASE' as const };
const decodeContribution = Schema.decodeUnknownSync(PricingDiscountContributionSchema, {
  onExcessProperty: 'error',
});

const percentageContribution = (
  audience: typeof catalogAudience | typeof priceGroupAudience | typeof counterpartyAudience,
) => ({
  amount: { amount: '-100', currencyCode: 'CZK' },
  discountType: {
    audience,
    effect: { kind: 'PERCENTAGE' as const, level: '10' },
    family: audience.kind === 'CATALOG_PATH' ? ('CATALOG_DISCOUNT' as const) : ('CONTRACTUAL_DISCOUNT' as const),
    scope: 'VARIANT_LINE' as const,
  },
  monetaryBoundary: 'PRE_TAX' as const,
  target: lineTarget,
});

describe('Pricing Discount interpretation service', () => {
  it.effect('preserves Catalog, Price Group, and Counterparty line contributions as independent layers', () =>
    Effect.gen(function* preservesIndependentLayers() {
      const contributions = yield* Effect.forEach(
        [catalogAudience, priceGroupAudience, counterpartyAudience],
        (audience) => interpretPricingDiscountContribution(decodeContribution(percentageContribution(audience))),
      );

      expect(contributions.map(({ layer }) => layer)).toEqual(['CATALOG_PATH', 'PRICE_GROUP', 'COUNTERPARTY']);
      expect(contributions.map(({ applicationCount }) => applicationCount)).toEqual([
        'ONCE_PER_STABLE_LINE',
        'ONCE_PER_STABLE_LINE',
        'ONCE_PER_STABLE_LINE',
      ]);
      expect(contributions.map(({ effectSemantics }) => effectSemantics)).toEqual([
        { basis: 'DISCOUNTABLE_LINE_BASIS', kind: 'PERCENTAGE', level: '10' },
        { basis: 'DISCOUNTABLE_LINE_BASIS', kind: 'PERCENTAGE', level: '10' },
        { basis: 'DISCOUNTABLE_LINE_BASIS', kind: 'PERCENTAGE', level: '10' },
      ]);
    }),
  );

  it.effect('interprets fixed effects once per declared scope without multiplying by line quantity', () =>
    Effect.gen(function* interpretsApplicationCount() {
      const lineContribution = {
        amount: { amount: '-100', currencyCode: 'CZK' },
        discountType: {
          audience: priceGroupAudience,
          effect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: { amount: '100', currencyCode: 'CZK' } },
          family: 'CONTRACTUAL_DISCOUNT' as const,
          scope: 'VARIANT_LINE' as const,
        },
        monetaryBoundary: 'PRE_TAX' as const,
        target: lineTarget,
      };
      const wholePurchaseContribution = {
        ...lineContribution,
        discountType: {
          ...lineContribution.discountType,
          audience: counterpartyAudience,
          scope: 'WHOLE_PURCHASE' as const,
        },
        target: wholePurchaseTarget,
      };

      const interpretedLine = yield* interpretPricingDiscountContribution(decodeContribution(lineContribution));
      const interpretedWhole = yield* interpretPricingDiscountContribution(
        decodeContribution(wholePurchaseContribution),
      );

      expect(interpretedLine.applicationCount).toBe('ONCE_PER_STABLE_LINE');
      expect(interpretedLine.effectSemantics).toEqual({
        configuredAmount: { amount: '100', currencyCode: 'CZK' },
        kind: 'FIXED_MONETARY_AMOUNT',
        multiplication: 'ONCE',
      });
      expect(interpretedWhole.applicationCount).toBe('ONCE_PER_PRICING_DECISION');
      expect(interpretedWhole.effectSemantics).toEqual(interpretedLine.effectSemantics);
    }),
  );

  it.effect('retains the exact Variant, commercial scope, currency, and Pricing basis binding', () =>
    Effect.gen(function* retainsExactBinding() {
      const interpreted = yield* interpretPricingDiscountContribution(
        decodeContribution(percentageContribution(catalogAudience)),
      );

      expect(interpreted.contribution.target).toEqual(lineTarget);
      expect(interpreted.contribution.target.decision.commercialScope).toEqual(decision.commercialScope);
      expect(interpreted.contribution.target.decision.currencyCode).toBe('CZK');
      expect(interpreted.contribution.target.decision.lines[0]?.pricingBasis).toEqual(line.pricingBasis);
    }),
  );

  it.effect('maps malformed or incoherent contributions to one typed rejection', () =>
    Effect.gen(function* mapsInvalidContribution() {
      const valid = decodeContribution(percentageContribution(counterpartyAudience));
      const invalid = {
        ...valid,
        amount: { amount: '1', currencyCode: 'CZK' },
      };

      const rejection = yield* Effect.flip(interpretPricingDiscountContribution(invalid));

      expect(rejection).toBeInstanceOf(PricingDiscountInterpretationRejected);
      expect(rejection).toMatchObject({ code: 'CONTRIBUTION_INVALID' });
    }),
  );
});
