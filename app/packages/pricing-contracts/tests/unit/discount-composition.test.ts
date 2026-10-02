import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountCardinalityConflictSchema,
  PricingDiscountCompositionCandidateSchema,
  PricingDiscountLineContributionSchema,
  PricingDiscountWholePurchaseContributionSchema,
  PricingDiscountableLineBasisSchema,
} from '../../src/domain/discount-composition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '66666666-6666-4666-8666-666666666666',
};
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
    attestationId: '12121212-1212-4212-8212-121212121212',
    observedAt: '2026-09-27T09:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const decisionLine = {
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
      requested: '1',
      resulting: '1',
      rounding: 'HALF_UP' as const,
      status: 'VALID' as const,
      step: '1',
      targetId: variantRef.resourceId,
      tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision: 7,
    },
    quantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: variantRef,
      unitRef,
      unitRuleRevision: 7,
    },
    selection,
    status: 'READY' as const,
    unitRef,
  },
  occurrenceId: 'line-1',
  pricingBasis: { quantity: '1', unitRef },
};
const decision = {
  commercialScope,
  currencyCode: 'CZK',
  lines: [decisionLine],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-27T10:00:00.000Z',
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:41',
      decisionRevision: 'commerce-access-decision-revision:41',
    },
    actor: { kind: 'PRINCIPAL' as const, principalId: 'pricing-principal:41' },
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
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
      kind: 'PROFILE' as const,
      profileRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'counterparty-profile:41',
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
        tenantId,
      },
    },
  },
  tenantId,
};
const lineBasis = {
  catalogSelection: selection,
  kind: 'VARIANT_LINE' as const,
  unitBasis: { quantity: '1', unitRef },
};
const counterpartyAudience = { counterpartyRef, kind: 'COUNTERPARTY' as const };

const definition = (
  discountId: string,
  revisionId: string,
  effect:
    | { readonly kind: 'PERCENTAGE'; readonly level: string }
    | {
        readonly kind: 'FIXED_MONETARY_AMOUNT';
        readonly level: { readonly amount: string; readonly currencyCode: string };
      },
) => ({
  discountId,
  identityKey: {
    audience: counterpartyAudience,
    basis: lineBasis,
    commercialScope,
    currencyCode: 'CZK',
    effectKind: effect.kind,
    family: 'CONTRACTUAL_DISCOUNT' as const,
    monetaryBoundary: 'PRE_TAX' as const,
    scope: 'VARIANT_LINE' as const,
  },
  revision: {
    configuredEffect: effect,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    revision: 1,
    revisionId,
  },
});

const audienceBinding = (currentDefinition: { readonly identityKey: unknown }) => ({
  applicabilityBasis: {
    basis: lineBasis,
    commercialScope,
    currencyCode: 'CZK',
    observedAt: '2026-09-27T10:00:00.000Z',
  },
  basePricePath: {
    kind: 'PRICE_GROUP_PRICE' as const,
    priceGroupRef: {
      moduleId: 'pricing.price-group-catalog' as const,
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'pricing.price-group-catalog.price-group' as const,
      tenantId,
    },
    priceRef: {
      moduleId: 'commerce.pricing' as const,
      resourceId: '88888888-8888-4888-8888-888888888888',
      resourceType: 'commerce.pricing.price' as const,
      tenantId,
    },
    priceRevisionId: '99999999-9999-4999-8999-999999999999',
  },
  evidence: {
    audience: counterpartyAudience,
    kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
    observedAt: '2026-09-27T10:00:00.000Z',
    ownerRevision: 'party-registry:41',
    source: 'PARTY_REGISTRY' as const,
  },
  identityKey: currentDefinition.identityKey,
});

const lineCandidate = (currentDefinition: ReturnType<typeof definition>) => ({
  applicationCount: 'ONCE_PER_STABLE_LINE' as const,
  audienceBinding: audienceBinding(currentDefinition),
  definition: currentDefinition,
  kind: 'VARIANT_LINE' as const,
  layer: 'COUNTERPARTY_CONTRACTUAL' as const,
  occurrenceId: 'line-1',
  outcome: 'DISCOUNT_APPLICABLE' as const,
});

const decodeBasis = Schema.decodeUnknownSync(PricingDiscountableLineBasisSchema, { onExcessProperty: 'error' });
const decodeCandidate = Schema.decodeUnknownSync(PricingDiscountCompositionCandidateSchema, {
  onExcessProperty: 'error',
});
const decodeLineContribution = Schema.decodeUnknownSync(PricingDiscountLineContributionSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Discount composition contracts (#772)', () => {
  it('defines one exact fee-inclusive basis without a running Discount subtotal', () => {
    const basis = {
      amount: { amount: '1000.25', currencyCode: 'CZK' },
      applicablePricingFeeTotal: { amount: '0.25', currencyCode: 'CZK' },
      baseLineValue: { amount: '1000', currencyCode: 'CZK' },
      occurrenceId: 'line-1',
    };

    expect(decodeBasis(basis)).toEqual(basis);
    expect(() => decodeBasis({ ...basis, amount: { amount: '1000.24', currencyCode: 'CZK' } })).toThrow();
    expect(() =>
      decodeBasis({ ...basis, applicablePricingFeeTotal: { amount: '0.25', currencyCode: 'EUR' } }),
    ).toThrow();
  });

  it('calculates each percentage independently from the common basis and fixed once per line', () => {
    const basis = decodeBasis({
      amount: { amount: '1000', currencyCode: 'CZK' },
      applicablePricingFeeTotal: { amount: '0', currencyCode: 'CZK' },
      baseLineValue: { amount: '1000', currencyCode: 'CZK' },
      occurrenceId: 'line-1',
    });
    const percentageCandidate = lineCandidate(
      definition('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
        kind: 'PERCENTAGE',
        level: '5',
      }),
    );
    const fixedCandidate = lineCandidate(
      definition('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
        kind: 'FIXED_MONETARY_AMOUNT',
        level: { amount: '7.50', currencyCode: 'CZK' },
      }),
    );

    expect(
      decodeLineContribution({
        amount: { amount: '-50', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_STABLE_LINE',
        basis,
        candidate: percentageCandidate,
        contributionDirection: 'NON_POSITIVE_REDUCTION',
      }).amount.amount,
    ).toBe('-50');
    expect(() =>
      decodeLineContribution({
        amount: { amount: '-47.5', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_STABLE_LINE',
        basis,
        candidate: percentageCandidate,
        contributionDirection: 'NON_POSITIVE_REDUCTION',
      }),
    ).toThrow();
    expect(
      decodeLineContribution({
        amount: { amount: '-7.5', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_STABLE_LINE',
        basis,
        candidate: fixedCandidate,
        contributionDirection: 'NON_POSITIVE_REDUCTION',
      }).amount.amount,
    ).toBe('-7.5');
  });

  it('reports distinct logical facts in one layer/path as cardinality, not Revision, conflict', () => {
    const percentageCandidate = decodeCandidate(
      lineCandidate(
        definition('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
          kind: 'PERCENTAGE',
          level: '5',
        }),
      ),
    );
    const fixedCandidate = decodeCandidate(
      lineCandidate(
        definition('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
          kind: 'FIXED_MONETARY_AMOUNT',
          level: { amount: '7.5', currencyCode: 'CZK' },
        }),
      ),
    );
    const decode = Schema.decodeUnknownSync(PricingDiscountCardinalityConflictSchema, {
      onExcessProperty: 'error',
    });

    expect(
      decode({
        claimants: [percentageCandidate, fixedCandidate],
        conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
        path: {
          kind: 'VARIANT_LINE_LAYER',
          layer: 'COUNTERPARTY_CONTRACTUAL',
          occurrenceId: 'line-1',
        },
      }).conflictKind,
    ).toBe('DISCOUNT_LAYER_CARDINALITY');
    expect(
      decode({
        claimants: [percentageCandidate, percentageCandidate],
        conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
        path: {
          kind: 'VARIANT_LINE_LAYER',
          layer: 'COUNTERPARTY_CONTRACTUAL',
          occurrenceId: 'line-1',
        },
      }).claimants,
    ).toHaveLength(2);
  });

  it('preserves the already-proven whole-purchase contribution once without allocation fields', () => {
    const wholeDefinition = {
      ...definition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', {
        kind: 'FIXED_MONETARY_AMOUNT' as const,
        level: { amount: '100', currencyCode: 'CZK' },
      }),
      identityKey: {
        ...definition('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', {
          kind: 'FIXED_MONETARY_AMOUNT' as const,
          level: { amount: '100', currencyCode: 'CZK' },
        }).identityKey,
        basis: { kind: 'WHOLE_PURCHASE' as const },
        scope: 'WHOLE_PURCHASE' as const,
      },
    };
    const binding = {
      ...audienceBinding(wholeDefinition),
      applicabilityBasis: {
        basis: { kind: 'WHOLE_PURCHASE' as const },
        commercialScope,
        currencyCode: 'CZK',
        observedAt: '2026-09-27T10:00:00.000Z',
      },
      identityKey: wholeDefinition.identityKey,
    };
    const applicability = {
      basis: {
        currencyCode: 'CZK',
        eligibleAmount: '820',
        recipients: [
          {
            intermediateValue: { amount: '820', currencyCode: 'CZK' },
            occurrenceId: 'line-1',
            recipientKind: 'MERCHANDISE' as const,
          },
        ],
      },
      contribution: { amount: '-100', currencyCode: 'CZK' },
      definition: wholeDefinition,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE' as const,
    };
    const candidate = {
      applicability,
      applicationCount: 'ONCE_PER_PRICING_DECISION' as const,
      audienceBinding: binding,
      decision,
      definition: wholeDefinition,
      kind: 'WHOLE_PURCHASE' as const,
      layer: 'COUNTERPARTY_WHOLE_PURCHASE' as const,
      outcome: 'DISCOUNT_APPLICABLE' as const,
    };
    const decode = Schema.decodeUnknownSync(PricingDiscountWholePurchaseContributionSchema, {
      onExcessProperty: 'error',
    });

    expect(
      decode({
        amount: { amount: '-100.0', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        candidate,
        contributionDirection: 'NON_POSITIVE_REDUCTION',
      }).applicationCount,
    ).toBe('ONCE_PER_PRICING_DECISION');
    expect(() =>
      decode({
        allocation: [],
        amount: { amount: '-100', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        candidate,
        contributionDirection: 'NON_POSITIVE_REDUCTION',
      }),
    ).toThrow();
  });
});
