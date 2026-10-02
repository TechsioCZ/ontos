import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingExplicitInputClassificationSchema,
  PricingExplicitInputConflictSchema,
  PricingExplicitInputContextSchema,
  PricingExplicitInputEvaluationRequestSchema,
  PricingExplicitInputIndeterminateSchema,
  PricingExplicitInputStaleSchema,
  PricingKnownInvalidExplicitInputSchema,
  PricingLegitimateGroupAbsenceSchema,
  PricingNonCanonicalAssertionHeldSchema,
} from '../../src/domain/broken-explicit-input.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const context = {
  effectiveAt,
  requestedCurrencyCode: 'CZK',
  tenantId,
} as const;
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const selection = {
  configuration: {
    choices: [{ choiceKey: 'finish', value: 'blue' }],
    definition: {
      resourceRef: catalogRef('88888888-8888-4888-8888-888888888888', 'commerce.catalog.configuration-definition'),
      revision: 4,
    },
    productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
    variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
  },
  packageOption: {
    contentRevision: {
      resourceRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
      revision: 5,
    },
    optionRef: catalogRef('99999999-9999-4999-8999-999999999999', 'commerce.catalog.package-definition'),
  },
  productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
  variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
} as const;
const basis = {
  catalogSelection: selection,
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
  },
} as const;
const decodeClassification = Schema.decodeUnknownSync(PricingExplicitInputClassificationSchema, {
  onExcessProperty: 'error',
});

describe('Issue #765 broken explicit Pricing input contracts', () => {
  it('binds an exact Price key to the requested native currency without narrowing generalized currencies', () => {
    const exactKey = {
      catalogSelection: selection,
      commercialScope: basis.commercialScope,
      currencyCode: 'EUR',
      priceGroupSelector: { kind: 'NO_GROUP' },
      unitBasis: basis.unitBasis,
    } as const;

    expect(
      Schema.is(PricingExplicitInputContextSchema)({
        ...context,
        exactKey,
        requestedCurrencyCode: 'EUR',
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingExplicitInputContextSchema)({
        ...context,
        exactKey,
        requestedCurrencyCode: 'CZK',
      }),
    ).toBe(false);
  });

  it('keeps known-invalid explicit input separate from legitimate absence', () => {
    const broken = decodeClassification({
      _tag: 'KNOWN_INVALID',
      context,
      evidenceRefs: ['commerce.customer-context:assignment:17'],
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reason: 'BROKEN_PRICE_GROUP_ASSIGNMENT',
      retryable: false,
      subject: 'PRICE_GROUP_ASSIGNMENT',
    });

    expect(Schema.is(PricingKnownInvalidExplicitInputSchema)(broken)).toBe(true);
    expect('continuation' in broken).toBe(false);
    expect(() =>
      decodeClassification({
        ...broken,
        _tag: 'LEGITIMATE_GROUP_ABSENCE',
        continuation: 'TRY_EXACT_NO_GROUP_PRICE',
      }),
    ).toThrow();
  });

  it('requires two distinct truths for conflicts and preserves stale invalidation', () => {
    expect(
      Schema.is(PricingExplicitInputConflictSchema)(
        decodeClassification({
          _tag: 'CONFLICT',
          context,
          currentTruthRefs: ['pricing:price:1', 'pricing:price:2'],
          outcome: 'PRICING_CONFLICT',
          reason: 'COMPETING_CURRENT_EXACT_PRICES',
          retryable: false,
          subject: 'EXACT_PRICE',
        }),
      ),
    ).toBe(true);
    expect(() =>
      decodeClassification({
        _tag: 'CONFLICT',
        context,
        currentTruthRefs: ['pricing:price:1', 'pricing:price:1'],
        outcome: 'PRICING_CONFLICT',
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
        subject: 'EXACT_PRICE',
      }),
    ).toThrow();

    expect(
      Schema.decodeSync(PricingExplicitInputStaleSchema)({
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason: 'MATERIAL_INPUT_CHANGED',
        retryable: true,
        staleEvidence: {
          assessedAt: effectiveAt,
          invalidatedAt: '2026-09-27T12:00:01.000Z',
          invalidatedRevision: 'pricing:revision:42',
        },
        subject: 'EXACT_PRICE',
      }).outcome,
    ).toBe('PRICING_STALE');
  });

  it('keeps unavailable and unverifiable owner state indeterminate instead of absence', () => {
    for (const reason of ['CURRENCY_SUPPORT_UNAVAILABLE', 'CURRENCY_SUPPORT_UNVERIFIABLE'] as const) {
      const decoded = decodeClassification({
        _tag: 'INDETERMINATE',
        context,
        inabilityEvidence: {
          attempts: 1,
          evidenceRefs: [],
          requiredOwners: ['PRICING_CURRENCY_SUPPORT'],
        },
        outcome: 'PRICING_INDETERMINATE',
        reason,
        retryable: true,
        subject: 'CURRENCY_SUPPORT',
      });
      expect(Schema.is(PricingExplicitInputIndeterminateSchema)(decoded)).toBe(true);
    }

    expect(
      Schema.is(PricingExplicitInputEvaluationRequestSchema)({
        context,
        currencySupportConflictRefs: ['pricing:support:revision:1', 'pricing:support:revision:2'],
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingExplicitInputEvaluationRequestSchema)({
        context,
        currencySupport: {
          code: 'pricing_currency_support_revision_conflict',
          outcome: 'SUPPORTED_CURRENCIES_INVALID',
          reason: 'Competing Current currency-support revisions',
          retryable: false,
        },
        currencySupportConflictRefs: ['pricing:support:revision:1', 'pricing:support:revision:2'],
      }),
    ).toBe(true);
  });

  it('binds assignment conflict claimants to the blocked inconsistent owner path', () => {
    const priceGroupResolutionInput = {
      _tag: 'BLOCKED',
      effectiveAt,
      interpretation: {
        _tag: 'INCONSISTENT',
        assignmentResolution: { _tag: 'INCONSISTENT', currentAssignmentCount: 2 },
        basis,
        currentAssignmentCount: 2,
      },
    } as const;

    expect(
      Schema.is(PricingExplicitInputEvaluationRequestSchema)({
        context,
        priceGroupConflictRefs: ['commerce:assignment:1', 'commerce:assignment:2'],
        priceGroupResolutionInput,
      }),
    ).toBe(true);
    expect(
      Schema.is(PricingExplicitInputEvaluationRequestSchema)({
        context,
        priceGroupConflictRefs: ['commerce:assignment:1', 'commerce:assignment:2'],
      }),
    ).toBe(false);
  });

  it('holds tax-inclusive assertions without turning them into canonical Price truth', () => {
    const held = Schema.decodeSync(PricingNonCanonicalAssertionHeldSchema)({
      _tag: 'NON_CANONICAL_ASSERTION_HELD',
      assessment: {
        outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
        sourceAssertionId: '22222222-2222-4222-8222-222222222222',
      },
      context,
      outcome: 'PRICING_INDETERMINATE',
      reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
      retryable: true,
      subject: 'SOURCE_ASSERTION',
    });

    expect(held.outcome).toBe('PRICING_INDETERMINATE');
    expect(() =>
      Schema.decodeSync(PricingNonCanonicalAssertionHeldSchema)({
        ...held,
        reason: 'MARKET_UNRESOLVED',
      }),
    ).toThrow();
  });

  it('allows no-group lookup only from owner-issued legitimate NONE evidence', () => {
    const legitimate = Schema.decodeSync(PricingLegitimateGroupAbsenceSchema)({
      _tag: 'LEGITIMATE_GROUP_ABSENCE',
      context,
      continuation: 'TRY_EXACT_NO_GROUP_PRICE',
      ownerResolution: {
        effectiveAt,
        profile: {
          kind: 'RETAIL',
          moduleId: 'commerce.customer-context',
          resourceId: '33333333-3333-4333-8333-333333333333',
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId,
        },
        resolution: { _tag: 'NONE' },
      },
    });
    expect(legitimate.continuation).toBe('TRY_EXACT_NO_GROUP_PRICE');

    expect(() =>
      Schema.decodeSync(PricingLegitimateGroupAbsenceSchema)({
        ...legitimate,
        ownerResolution: {
          ...legitimate.ownerResolution,
          resolution: {
            _tag: 'INCONSISTENT',
            currentAssignmentCount: 2,
          },
        },
      }),
    ).toThrow();
  });
});
