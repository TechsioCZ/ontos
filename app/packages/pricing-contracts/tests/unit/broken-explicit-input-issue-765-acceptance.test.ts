import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingExplicitConfigurationReasonSchema,
  PricingExplicitConflictReasonSchema,
  PricingExplicitInputConflictSchema,
  PricingExplicitIndeterminateReasonSchema,
  PricingExplicitInputClassificationSchema,
  PricingExplicitInputContextSchema,
  PricingExplicitInputEvaluationResultSchema,
  PricingExplicitInputIndeterminateSchema,
  PricingExplicitInputStaleSchema,
  PricingKnownInvalidExplicitInputSchema,
  PricingLegitimateExactPathAbsenceSchema,
  PricingLegitimateGroupAbsenceSchema,
  PricingNonCanonicalAssertionHeldSchema,
  PricingExplicitStaleReasonSchema,
} from '../../src/domain/broken-explicit-input.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const effectiveAt = '2026-09-27T12:00:00.000Z';

const catalogRef = (resourceId: string, resourceType: string, ownerTenantId = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: ownerTenantId,
});

const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;

const catalogSelection = {
  productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
  variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
} as const;

const unitBasis = {
  quantity: '1',
  unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
} as const;

const commercialScope = {
  channelId: 'B2C',
  marketId: 'cz-launch',
  sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

const exactKey = {
  catalogSelection,
  commercialScope,
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis,
} as const;

const context = {
  effectiveAt,
  exactKey,
  requestedCurrencyCode: 'CZK',
  tenantId,
} as const;
const contextWithoutExactKey = {
  effectiveAt,
  requestedCurrencyCode: 'CZK',
  tenantId,
} as const;

const ownerNoneResolution = {
  effectiveAt,
  profile,
  resolution: { _tag: 'NONE' },
} as const;

const noneInterpretation = {
  _tag: 'NONE',
  assignmentResolution: { _tag: 'NONE' },
  basis: {
    catalogSelection,
    commercialScope,
    currencyCode: 'CZK',
    unitBasis,
  },
  discountAudience: { kind: 'NONE' },
  priceSelector: { kind: 'NO_GROUP' },
} as const;

const ownerNoneInput = {
  _tag: 'OWNER_NONE',
  effectiveAt,
  interpretation: noneInterpretation,
  ownerResolution: ownerNoneResolution,
} as const;

const exactAbsence = {
  _tag: 'ABSENT',
  evidence: {
    effectiveAt,
    nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
    observedAt: '2026-09-27T12:00:00.050Z',
    ownerRevision: 'pricing-price-set:17',
  },
  request: { effectiveAt, exactKey },
} as const;

const noApplicablePath = {
  _tag: 'NO_APPLICABLE_PRICE',
  noGroupAbsence: exactAbsence,
  resolutionInput: ownerNoneInput,
} as const;

const decodeClassification = Schema.decodeUnknownSync(PricingExplicitInputClassificationSchema, {
  onExcessProperty: 'error',
});
const decodeContext = Schema.decodeUnknownSync(PricingExplicitInputContextSchema, {
  onExcessProperty: 'error',
});
const decodeResult = Schema.decodeUnknownSync(PricingExplicitInputEvaluationResultSchema, {
  onExcessProperty: 'error',
});

describe('Issue #765 broken explicit Pricing input acceptance contract', () => {
  it('keeps the complete known-invalid inventory non-retryable and distinct from absence', () => {
    const cases = [
      ['PRICE_GROUP_ASSIGNMENT', 'BROKEN_PRICE_GROUP_ASSIGNMENT'],
      ['CATALOG_SELECTION', 'MISSING_EXACT_VARIANT'],
      ['COMMERCIAL_SCOPE', 'MISSING_COMMERCE_MARKET'],
      ['CATALOG_SELECTION', 'INVALID_VARIANT_PARENTAGE'],
      ['COMMERCIAL_SCOPE', 'INVALID_SELLER_CHANNEL_MARKET_COMBINATION'],
      ['CURRENCY_SUPPORT', 'UNSUPPORTED_CURRENCY'],
      ['CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_NOT_INITIALIZED'],
      ['QUANTITY_BASIS', 'INCOMPATIBLE_QUANTITY_UNIT'],
      ['QUANTITY_BASIS', 'INCOMPATIBLE_PRICING_BASIS'],
      ['EXACT_PRICE', 'INVALID_SIGN_OR_RANGE'],
      ['DISCOUNT', 'INVALID_CONTRIBUTION_EFFECT'],
      ['EXACT_PRICE', 'INVALID_CANONICAL_CONFIGURATION'],
      ['CATALOG_SELECTION', 'PRODUCT_ONLY_PRICE_TARGET'],
      ['COMMERCIAL_SCOPE', 'STOREFRONT_PRICE_SELECTOR_FORBIDDEN'],
      ['CURRENCY_SUPPORT', 'CROSS_CURRENCY_SUBSTITUTION_FORBIDDEN'],
      ['EXACT_PRICE', 'GROSS_ONLY_CANONICAL_PRICE'],
      ['ZERO_FLOOR_AUTHORIZATION', 'ZERO_FLOOR_SCOPE_MISMATCH'],
      ['ZERO_FLOOR_AUTHORIZATION', 'ZERO_FLOOR_EFFECTIVE_PERIOD_MISMATCH'],
      ['ZERO_FLOOR_AUTHORIZATION', 'ZERO_FLOOR_ECONOMIC_ENVELOPE_MISMATCH'],
    ] as const;

    for (const [subject, reason] of cases) {
      const decoded = decodeClassification({
        _tag: 'KNOWN_INVALID',
        context: reason === 'MISSING_EXACT_VARIANT' ? contextWithoutExactKey : context,
        evidenceRefs: [`owner:${subject}:${reason}`],
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reason,
        retryable: false,
        subject,
      });
      expect(Schema.is(PricingKnownInvalidExplicitInputSchema)(decoded)).toBe(true);
      expect(decoded).toMatchObject({ outcome: 'PRICING_CONFIGURATION_ERROR', reason });
      expect(Schema.is(PricingLegitimateExactPathAbsenceSchema)(decoded)).toBe(false);
    }

    expect(Schema.is(PricingExplicitConfigurationReasonSchema)('BROKEN_PRICE_GROUP_ASSIGNMENT')).toBe(true);
    expect(Schema.is(PricingExplicitConfigurationReasonSchema)('NO_APPLICABLE_PRICE')).toBe(false);
  });

  it('keeps inconsistent assignments and competing exact truths as conflicts with no fallback winner', () => {
    for (const [subject, reason] of [
      ['PRICE_GROUP_ASSIGNMENT', 'INCONSISTENT_PRICE_GROUP_ASSIGNMENT'],
      ['EXACT_PRICE', 'COMPETING_CURRENT_EXACT_PRICES'],
      ['CURRENCY_SUPPORT', 'COMPETING_CURRENT_CURRENCY_SUPPORT'],
      ['EXACT_PRICE', 'CANONICAL_STATE_CONFLICT'],
    ] as const) {
      const decoded = decodeClassification({
        _tag: 'CONFLICT',
        context,
        currentTruthRefs: ['owner-current:1', 'owner-current:2'],
        outcome: 'PRICING_CONFLICT',
        reason,
        retryable: false,
        subject,
      });
      expect(Schema.is(PricingExplicitInputConflictSchema)(decoded)).toBe(true);
      expect(decoded).toMatchObject({ outcome: 'PRICING_CONFLICT', reason });
    }

    expect(Schema.is(PricingExplicitConflictReasonSchema)('INCONSISTENT_PRICE_GROUP_ASSIGNMENT')).toBe(true);
    expect(() =>
      decodeClassification({
        _tag: 'CONFLICT',
        context,
        currentTruthRefs: ['owner-current:1', 'owner-current:2'],
        fallbackAmount: '0',
        fallbackKey: { ...exactKey, priceGroupSelector: { kind: 'NO_GROUP' } },
        outcome: 'PRICING_CONFLICT',
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
        subject: 'EXACT_PRICE',
      }),
    ).toThrow();
  });

  it('keeps stale evidence separate from owner unavailability and unverifiability', () => {
    for (const reason of [
      'INPUT_REVISION_STALE',
      'PRICE_REVISION_STALE',
      'PROOF_STALE',
      'APPLICABILITY_BOUNDARY_CROSSED',
      'AUTHORIZATION_STALE',
      'MATERIAL_INPUT_CHANGED',
    ] as const) {
      const decoded = decodeClassification({
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason,
        retryable: true,
        staleEvidence: {
          assessedAt: effectiveAt,
          invalidatedAt: '2026-09-27T12:00:01.000Z',
          invalidatedRevision: `revision:${reason}`,
        },
        subject: 'EXACT_PRICE',
      });
      expect(Schema.is(PricingExplicitInputStaleSchema)(decoded)).toBe(true);
      expect(decoded).toMatchObject({ reason });
    }

    expect(Schema.is(PricingExplicitStaleReasonSchema)('CURRENCY_SUPPORT_UNAVAILABLE')).toBe(false);
    expect(() =>
      decodeClassification({
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason: 'PROOF_STALE',
        retryable: true,
        staleEvidence: {
          assessedAt: effectiveAt,
          invalidatedAt: effectiveAt,
          invalidatedRevision: 'revision:not-later',
        },
        subject: 'EXACT_PRICE',
      }),
    ).toThrow();
  });

  it('keeps every required owner-state failure indeterminate instead of fabricating absence', () => {
    const cases = [
      ['PRICE_GROUP_DEFINITION', 'PRICE_GROUP_OWNER_UNAVAILABLE', 'PRICE_GROUP_CATALOG'],
      ['PRICE_GROUP_DEFINITION', 'PRICE_GROUP_OWNER_UNVERIFIABLE', 'PRICE_GROUP_CATALOG'],
      ['CATALOG_SELECTION', 'CATALOG_OWNER_UNAVAILABLE', 'CATALOG'],
      ['CATALOG_SELECTION', 'CATALOG_OWNER_UNVERIFIABLE', 'CATALOG'],
      ['COMMERCIAL_SCOPE', 'COMMERCIAL_SCOPE_UNAVAILABLE', 'COMMERCE_MARKET_CATALOG'],
      ['COMMERCIAL_SCOPE', 'COMMERCIAL_SCOPE_UNVERIFIABLE', 'COMMERCE_MARKET_CATALOG'],
      ['CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_UNAVAILABLE', 'PRICING_CURRENCY_SUPPORT'],
      ['CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_UNVERIFIABLE', 'PRICING_CURRENCY_SUPPORT'],
      ['EXACT_PRICE', 'EXACT_PRICE_STATE_UNAVAILABLE', 'PRICING_EXACT_PRICE'],
      ['EXACT_PRICE', 'EXACT_PRICE_STATE_UNVERIFIABLE', 'PRICING_EXACT_PRICE'],
      ['QUANTITY_BASIS', 'QUANTITY_BASIS_UNAVAILABLE', 'CATALOG'],
      ['QUANTITY_BASIS', 'QUANTITY_BASIS_UNVERIFIABLE', 'CATALOG'],
      ['QUANTITY_TIER', 'REQUIRED_TIER_STATE_UNVERIFIABLE', 'PRICING_QUANTITY_TIER'],
      ['DISCOUNT', 'REQUIRED_DISCOUNT_STATE_UNVERIFIABLE', 'PRICING_DISCOUNT'],
      ['COMMERCIAL_FEE', 'REQUIRED_FEE_STATE_UNVERIFIABLE', 'PRICING_COMMERCIAL_FEE'],
      ['ZERO_FLOOR_AUTHORIZATION', 'REQUIRED_ZERO_FLOOR_STATE_UNVERIFIABLE', 'PRICING_ZERO_FLOOR'],
      ['EXACT_PRICE', 'CURRENTNESS_UNVERIFIABLE', 'PRICING_EXACT_PRICE'],
      ['EXACT_PRICE', 'SET_COMPLETENESS_UNVERIFIABLE', 'PRICING_EXACT_PRICE'],
    ] as const;

    for (const [subject, reason, owner] of cases) {
      const decoded = decodeClassification({
        _tag: 'INDETERMINATE',
        context,
        inabilityEvidence: {
          attempts: 1,
          evidenceRefs: [`owner-attempt:${reason}`],
          requiredOwners: [owner],
        },
        outcome: 'PRICING_INDETERMINATE',
        reason,
        retryable: true,
        subject,
      });
      expect(Schema.is(PricingExplicitInputIndeterminateSchema)(decoded)).toBe(true);
      expect(decoded).toMatchObject({ outcome: 'PRICING_INDETERMINATE', reason });
      expect(Schema.is(PricingLegitimateExactPathAbsenceSchema)(decoded)).toBe(false);
    }

    expect(Schema.is(PricingExplicitIndeterminateReasonSchema)('EXACT_PRICE_STATE_UNVERIFIABLE')).toBe(true);
    expect(Schema.is(PricingExplicitIndeterminateReasonSchema)('NO_APPLICABLE_PRICE')).toBe(false);
  });

  it('holds gross-only and unresolved source assertions without making them canonical', () => {
    for (const reason of [
      'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
      'CURRENCY_NOT_SUPPORTED_FOR_TENANT',
      'TARGET_UNRESOLVED',
      'CANONICAL_CONFLICT_HELD',
    ] as const) {
      const decoded = decodeClassification({
        _tag: 'NON_CANONICAL_ASSERTION_HELD',
        assessment: {
          outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
          reason,
          sourceAssertionId: '88888888-8888-4888-8888-888888888888',
        },
        context,
        outcome: 'PRICING_INDETERMINATE',
        reason,
        retryable: true,
        subject: 'SOURCE_ASSERTION',
      });
      expect(Schema.is(PricingNonCanonicalAssertionHeldSchema)(decoded)).toBe(true);
      expect(decoded).toMatchObject({ outcome: 'PRICING_INDETERMINATE', reason });
      expect(decoded).not.toHaveProperty('canonicalPrice');
      expect(decoded).not.toHaveProperty('normalizedPreTaxAmount');
    }
  });

  it('preserves owner-proven NONE and complete exact absence as the only legitimate absence paths', () => {
    const groupAbsence = decodeClassification({
      _tag: 'LEGITIMATE_GROUP_ABSENCE',
      context,
      continuation: 'TRY_EXACT_NO_GROUP_PRICE',
      ownerResolution: ownerNoneResolution,
    });
    expect(Schema.is(PricingLegitimateGroupAbsenceSchema)(groupAbsence)).toBe(true);
    expect(groupAbsence).toMatchObject({ continuation: 'TRY_EXACT_NO_GROUP_PRICE' });

    const exactPathAbsence = decodeResult({
      _tag: 'LEGITIMATE_EXACT_PATH_ABSENCE',
      context,
      exactAbsence,
      outcome: 'NO_APPLICABLE_PRICE',
      path: noApplicablePath,
      retryable: false,
    });
    expect(Schema.is(PricingLegitimateExactPathAbsenceSchema)(exactPathAbsence)).toBe(true);
    expect(exactPathAbsence).toMatchObject({ outcome: 'NO_APPLICABLE_PRICE' });

    expect(() =>
      decodeClassification({
        _tag: 'LEGITIMATE_GROUP_ABSENCE',
        context,
        continuation: 'TRY_EXACT_NO_GROUP_PRICE',
        ownerResolution: {
          ...ownerNoneResolution,
          profile: { ...profile, tenantId: otherTenantId },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'LEGITIMATE_EXACT_PATH_ABSENCE',
        context,
        exactAbsence: {
          ...exactAbsence,
          request: {
            ...exactAbsence.request,
            exactKey: { ...exactKey, currencyCode: 'EUR' },
          },
        },
        outcome: 'NO_APPLICABLE_PRICE',
        path: noApplicablePath,
        retryable: false,
      }),
    ).toThrow();
  });

  it('admits generalized currency syntax but never activates EUR, FX, Storefront, or a broader key', () => {
    const eurUnsupported = decodeClassification({
      _tag: 'KNOWN_INVALID',
      context: { ...contextWithoutExactKey, requestedCurrencyCode: 'EUR' },
      evidenceRefs: ['tenant-support:CZK-only'],
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reason: 'UNSUPPORTED_CURRENCY',
      retryable: false,
      subject: 'CURRENCY_SUPPORT',
    });
    expect(eurUnsupported).toMatchObject({
      context: { requestedCurrencyCode: 'EUR' },
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reason: 'UNSUPPORTED_CURRENCY',
    });

    expect(() => decodeContext({ ...context, storefrontId: 'web-cz' })).toThrow();
    expect(() => decodeContext({ ...context, fxRate: '24.5', sourceCurrencyCode: 'EUR' })).toThrow();
    expect(() =>
      decodeContext({
        ...context,
        exactKey: {
          ...exactKey,
          catalogSelection: { productRef: catalogSelection.productRef },
        },
      }),
    ).toThrow();
  });
});
