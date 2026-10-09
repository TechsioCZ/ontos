import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceAbsentResolutionSchema,
  ExactPriceConfigurationErrorResolutionSchema,
  ExactPriceConflictResolutionSchema,
  ExactPriceFoundResolutionSchema,
  ExactPriceIndeterminateResolutionSchema,
  ExactPriceResolutionInputSchema,
  ExactPriceResolutionSchema,
} from '../../src/domain/exact-price-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const observedAt = '2026-09-27T12:00:00.050Z';
const supportRootId = '12121212-1212-4212-8212-121212121212';
const supportRevisionId = '13131313-1313-4313-8313-131313131313';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;

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
    marketId: 'CZ',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
  },
} as const;

const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: effectiveAt,
} as const;

const assignedInput = {
  _tag: 'ASSIGNED',
  effectiveAt,
  interpretation: {
    _tag: 'ASSIGNED',
    assignmentResolution: {
      _tag: 'ASSIGNED',
      assignmentRef: {
        moduleId: 'commerce.customer-context',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'commerce.customer-context.customer-price-group-assignment',
        tenantId,
      },
      assignmentRevision: 3,
      compatibility: compatibilityEvidence,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      priceGroupRef,
    },
    basis,
    compatibilityEvidence,
    discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
    priceGroupRef,
    priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
  },
} as const;

const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: supportRevisionId,
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId,
  tenantId,
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:763-contract-acceptance';
const currencySupport = {
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF',
    observedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootRef.resourceId, factRevisionRef: supportRevisionRef.resourceId, verificationRef }],
  generation: 7,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
} as const;

const exactKey = (
  priceGroupSelector:
    | { readonly kind: 'NO_GROUP' }
    | { readonly kind: 'PRICE_GROUP'; readonly priceGroupRef: typeof priceGroupRef },
) => ({
  catalogSelection: selection,
  commercialScope: basis.commercialScope,
  currencyCode: basis.currencyCode,
  priceGroupSelector,
  unitBasis: basis.unitBasis,
});

const currentEvidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision: 'pricing-current-state:41',
} as const;
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.price',
  tenantId,
} as const;
const requestFor = (priceGroupSelector: Parameters<typeof exactKey>[0]) => ({
  effectiveAt,
  exactKey: exactKey(priceGroupSelector),
});
const found = (priceGroupSelector: Parameters<typeof exactKey>[0]) => ({
  _tag: 'FOUND' as const,
  evidence: currentEvidence,
  priceRef,
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '0', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 2,
    revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
  request: requestFor(priceGroupSelector),
});
const absent = (priceGroupSelector: Parameters<typeof exactKey>[0]) => ({
  _tag: 'ABSENT' as const,
  evidence: currentEvidence,
  request: requestFor(priceGroupSelector),
});

const decodeInput = Schema.decodeUnknownSync(ExactPriceResolutionInputSchema, { onExcessProperty: 'error' });
const decodeResolution = Schema.decodeUnknownSync(ExactPriceResolutionSchema, { onExcessProperty: 'error' });

describe('Issue #763 exact Price resolution acceptance contract', () => {
  it('retains a zero-valued exact Group Price as PRICE_FOUND with the full owner path', () => {
    const usedPrice = found({ kind: 'PRICE_GROUP', priceGroupRef });
    const decoded = decodeResolution({
      _tag: 'PRICE_FOUND',
      currencySupport,
      path: {
        _tag: 'GROUP_PRICE',
        discountAudience: assignedInput.interpretation.discountAudience,
        resolutionInput: assignedInput,
        usedPrice,
      },
    });

    expect(Schema.is(ExactPriceFoundResolutionSchema)(decoded)).toBe(true);
    expect(decoded).toMatchObject({
      path: {
        _tag: 'GROUP_PRICE',
        usedPrice: {
          priceRevision: { monetaryAmount: { amount: '0' } },
          request: { exactKey: exactKey({ kind: 'PRICE_GROUP', priceGroupRef }) },
        },
      },
    });
    expect(decoded.currencySupport.supportedCurrencies).toEqual(['CZK']);
  });

  it('distinguishes proven assigned fallback from complete exact-path absence', () => {
    const groupAbsence = absent({ kind: 'PRICE_GROUP', priceGroupRef });
    const noGroupPrice = found({ kind: 'NO_GROUP' });
    const fallback = decodeResolution({
      _tag: 'PRICE_FOUND',
      currencySupport,
      path: {
        _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
        discountAudience: assignedInput.interpretation.discountAudience,
        groupAbsence,
        resolutionInput: assignedInput,
        usedPrice: noGroupPrice,
      },
    });
    expect(fallback).toMatchObject({ path: { _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE' } });

    const absence = decodeResolution({
      _tag: 'NO_APPLICABLE_PRICE',
      currencySupport,
      path: {
        _tag: 'NO_APPLICABLE_PRICE',
        groupAbsence,
        noGroupAbsence: absent({ kind: 'NO_GROUP' }),
        resolutionInput: assignedInput,
      },
    });
    expect(Schema.is(ExactPriceAbsentResolutionSchema)(absence)).toBe(true);
  });

  it('maps conflict, invalidity, and unavailable state without erasing exact owner evidence', () => {
    const request = requestFor({ kind: 'PRICE_GROUP', priceGroupRef });
    const conflict = {
      _tag: 'CONFLICT' as const,
      currentTruthRefs: [
        { priceRef, revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        {
          priceRef: { ...priceRef, resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        },
      ],
      evidence: currentEvidence,
      reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
      request,
    };
    const invalid = { _tag: 'INVALID' as const, reason: 'INVALID_CANONICAL_PRICE' as const, request };
    const unavailable = { _tag: 'UNAVAILABLE' as const, reason: 'EXACT_LOOKUP_UNAVAILABLE' as const, request };
    const cases = [
      {
        _tag: 'PRICING_CONFLICT' as const,
        path: {
          _tag: 'CONFLICT' as const,
          lookup: conflict,
          reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
          resolutionInput: assignedInput,
        },
      },
      {
        _tag: 'PRICING_CONFIGURATION_ERROR' as const,
        path: {
          _tag: 'CONFIGURATION_ERROR' as const,
          lookup: invalid,
          reason: invalid.reason,
          resolutionInput: assignedInput,
        },
      },
      {
        _tag: 'PRICING_INDETERMINATE' as const,
        path: {
          _tag: 'INDETERMINATE' as const,
          lookup: unavailable,
          reason: 'OWNER_STATE_UNAVAILABLE' as const,
          resolutionInput: assignedInput,
        },
      },
    ];

    expect(Schema.is(ExactPriceConflictResolutionSchema)(decodeResolution({ ...cases[0], currencySupport }))).toBe(
      true,
    );
    expect(
      Schema.is(ExactPriceConfigurationErrorResolutionSchema)(decodeResolution({ ...cases[1], currencySupport })),
    ).toBe(true);
    expect(Schema.is(ExactPriceIndeterminateResolutionSchema)(decodeResolution({ ...cases[2], currencySupport }))).toBe(
      true,
    );
    expect(() => decodeResolution({ _tag: 'NO_APPLICABLE_PRICE', currencySupport, path: cases[0]?.path })).toThrow();
  });

  it('requires exact Tenant Current currency support and never turns generalized EUR contracts into Launch FX', () => {
    expect(
      decodeInput({ currencySupport, resolutionInput: assignedInput }).currencySupport.supportedCurrencies,
    ).toEqual(['CZK']);

    const eurInput = {
      ...assignedInput,
      interpretation: {
        ...assignedInput.interpretation,
        basis: { ...basis, currencyCode: 'EUR' as const },
      },
    };
    expect(() => decodeInput({ currencySupport, resolutionInput: eurInput })).toThrow();

    const explicitlySupportedEur = {
      ...currencySupport,
      supportedCurrencies: ['CZK', 'EUR'] as const,
    };
    const decodedFutureNativeCurrency = decodeInput({
      currencySupport: explicitlySupportedEur,
      resolutionInput: eurInput,
    });
    expect(decodedFutureNativeCurrency).toMatchObject({
      resolutionInput: { _tag: 'ASSIGNED', interpretation: { basis: { currencyCode: 'EUR' } } },
    });
    expect(decodedFutureNativeCurrency.currencySupport.supportedCurrencies).toEqual(['CZK', 'EUR']);
  });
});
