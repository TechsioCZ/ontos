import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceGroupFallbackExactLookupResultSchema,
  PriceGroupFallbackResolutionInputSchema,
  PriceGroupFallbackResolutionSchema,
} from '../../src/domain/price-group-fallback.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
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
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.customer-context.retail-customer-profile',
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
    marketId: 'cz-launch',
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
const assignedResolution = {
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
} as const;
const assignedInput = {
  _tag: 'ASSIGNED',
  effectiveAt,
  interpretation: {
    _tag: 'ASSIGNED',
    assignmentResolution: assignedResolution,
    basis,
    compatibilityEvidence,
    discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
    priceGroupRef,
    priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
  },
} as const;
const ownerNoneInput = {
  _tag: 'OWNER_NONE',
  effectiveAt,
  interpretation: {
    _tag: 'NONE',
    assignmentResolution: { _tag: 'NONE' },
    basis,
    discountAudience: { kind: 'NONE' },
    priceSelector: { kind: 'NO_GROUP' },
  },
  ownerResolution: { effectiveAt, profile, resolution: { _tag: 'NONE' } },
} as const;
const guestInput = { _tag: 'GUEST', basis, effectiveAt } as const;
const exactKey = (
  priceGroupSelector:
    | { readonly kind: 'NO_GROUP' }
    | {
        readonly kind: 'PRICE_GROUP';
        readonly priceGroupRef: typeof priceGroupRef;
      },
) => ({
  catalogSelection: selection,
  commercialScope: basis.commercialScope,
  currencyCode: basis.currencyCode,
  priceGroupSelector,
  unitBasis: basis.unitBasis,
});
const evidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt: '2026-09-27T12:00:00.050Z',
  ownerRevision: 'pricing-current-state:41',
} as const;
const priceRef = {
  moduleId: 'commerce.pricing',
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.price',
  tenantId,
} as const;
const revision = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  monetaryAmount: { amount: '0', currencyCode: 'CZK' },
  monetaryBoundary: 'PRE_TAX',
  revision: 2,
  revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;
const found = (key: ReturnType<typeof exactKey>) => ({
  _tag: 'FOUND' as const,
  evidence,
  priceRef,
  priceRevision: revision,
  request: { effectiveAt, exactKey: key },
});
const absent = (key: ReturnType<typeof exactKey>) => ({
  _tag: 'ABSENT' as const,
  evidence,
  request: { effectiveAt, exactKey: key },
});

const decodeInput = Schema.decodeUnknownSync(PriceGroupFallbackResolutionInputSchema, {
  onExcessProperty: 'error',
});
const decodeLookup = Schema.decodeUnknownSync(PriceGroupFallbackExactLookupResultSchema, {
  onExcessProperty: 'error',
});
const decodeResolution = Schema.decodeUnknownSync(PriceGroupFallbackResolutionSchema, {
  onExcessProperty: 'error',
});
const FoundLookupTagSchema = Schema.TaggedStruct('FOUND', {});
const AssignedNoGroupFallbackTagSchema = Schema.TaggedStruct('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', {});
const OwnerNoneInputTagSchema = Schema.TaggedStruct('OWNER_NONE', {});
const GuestInputTagSchema = Schema.TaggedStruct('GUEST', {});
const GroupPriceTagSchema = Schema.TaggedStruct('GROUP_PRICE', {});
const NoGroupNoneTagSchema = Schema.TaggedStruct('NO_GROUP_NONE', {});
const NoGroupGuestTagSchema = Schema.TaggedStruct('NO_GROUP_GUEST', {});
const NoApplicablePriceTagSchema = Schema.TaggedStruct('NO_APPLICABLE_PRICE', {});
const ConfigurationErrorTagSchema = Schema.TaggedStruct('CONFIGURATION_ERROR', {});
const ConflictTagSchema = Schema.TaggedStruct('CONFLICT', {});
const IndeterminateTagSchema = Schema.TaggedStruct('INDETERMINATE', {});

describe('Issue #762 exact no-customer-Price-Group fallback contracts', () => {
  it('keeps owner NONE and Guest as separate no-group authorities', () => {
    expect(Schema.is(OwnerNoneInputTagSchema)(decodeInput(ownerNoneInput))).toBe(true);
    expect(Schema.is(GuestInputTagSchema)(decodeInput(guestInput))).toBe(true);
    expect(() =>
      decodeInput({
        ...ownerNoneInput,
        ownerResolution: { ...ownerNoneInput.ownerResolution, effectiveAt: '2026-09-27T11:59:59.999Z' },
      }),
    ).toThrow();
  });

  it('resolves the assigned exact Group Price and treats Price 0 as FOUND', () => {
    const usedPrice = found(exactKey({ kind: 'PRICE_GROUP', priceGroupRef }));
    const decodedLookup = decodeLookup(usedPrice);
    if (!Schema.is(FoundLookupTagSchema)(decodedLookup)) {
      throw new Error('fixture must decode as a found Price');
    }
    expect(decodedLookup.priceRevision.monetaryAmount.amount).toBe('0');
    expect(
      Schema.is(GroupPriceTagSchema)(
        decodeResolution({
          _tag: 'GROUP_PRICE',
          discountAudience: assignedInput.interpretation.discountAudience,
          resolutionInput: assignedInput,
          usedPrice,
        }),
      ),
    ).toBe(true);
  });

  it('distinguishes no-group NONE, Guest, and assigned fallback while preserving exact selection and Group audience', () => {
    const noGroupPrice = found(exactKey({ kind: 'NO_GROUP' }));
    const groupAbsence = absent(exactKey({ kind: 'PRICE_GROUP', priceGroupRef }));

    expect(
      Schema.is(NoGroupNoneTagSchema)(
        decodeResolution({
          _tag: 'NO_GROUP_NONE',
          discountAudience: { kind: 'NONE' },
          resolutionInput: ownerNoneInput,
          usedPrice: noGroupPrice,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(NoGroupGuestTagSchema)(
        decodeResolution({
          _tag: 'NO_GROUP_GUEST',
          discountAudience: { kind: 'NONE' },
          resolutionInput: guestInput,
          usedPrice: noGroupPrice,
        }),
      ),
    ).toBe(true);

    const fallback = decodeResolution({
      _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
      discountAudience: assignedInput.interpretation.discountAudience,
      groupAbsence,
      resolutionInput: assignedInput,
      usedPrice: noGroupPrice,
    });
    expect(Schema.is(AssignedNoGroupFallbackTagSchema)(fallback)).toBe(true);
    if (!Schema.is(AssignedNoGroupFallbackTagSchema)(fallback)) {
      throw new Error('fixture must decode as assigned no-group fallback');
    }
    expect(fallback.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
    expect(noGroupPrice.request.exactKey.catalogSelection).toEqual(selection);
  });

  it('requires absence of the complete allowed exact path before NO_APPLICABLE_PRICE', () => {
    const noGroupAbsence = absent(exactKey({ kind: 'NO_GROUP' }));
    const groupAbsence = absent(exactKey({ kind: 'PRICE_GROUP', priceGroupRef }));
    expect(
      Schema.is(NoApplicablePriceTagSchema)(
        decodeResolution({
          _tag: 'NO_APPLICABLE_PRICE',
          groupAbsence,
          noGroupAbsence,
          resolutionInput: assignedInput,
        }),
      ),
    ).toBe(true);
    expect(() =>
      decodeResolution({
        _tag: 'NO_APPLICABLE_PRICE',
        noGroupAbsence,
        resolutionInput: assignedInput,
      }),
    ).toThrow();
    expect(() =>
      decodeResolution({
        _tag: 'NO_APPLICABLE_PRICE',
        groupAbsence,
        noGroupAbsence,
        resolutionInput: guestInput,
      }),
    ).toThrow();
  });

  it('never converts conflicts, invalid state, unavailability, or unverifiable evidence into absence', () => {
    const request = { effectiveAt, exactKey: exactKey({ kind: 'PRICE_GROUP', priceGroupRef }) };
    for (const lookup of [
      {
        _tag: 'CONFLICT' as const,
        currentTruthRefs: [
          { priceRef, revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          {
            priceRef: { ...priceRef, resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
            revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          },
        ],
        evidence,
        reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
        request,
      },
      { _tag: 'INVALID' as const, reason: 'INVALID_CANONICAL_PRICE' as const, request },
      { _tag: 'UNAVAILABLE' as const, reason: 'EXACT_LOOKUP_UNAVAILABLE' as const, request },
      { _tag: 'UNVERIFIABLE' as const, reason: 'CURRENTNESS_UNVERIFIABLE' as const, request },
    ]) {
      expect(decodeLookup(lookup)).toEqual(lookup);
      expect(() =>
        decodeResolution({
          _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
          discountAudience: assignedInput.interpretation.discountAudience,
          groupAbsence: lookup,
          resolutionInput: assignedInput,
          usedPrice: found(exactKey({ kind: 'NO_GROUP' })),
        }),
      ).toThrow();
    }
  });

  it('keeps invalid, conflicting, and indeterminate lookup evidence attached to typed failure outcomes', () => {
    const request = { effectiveAt, exactKey: exactKey({ kind: 'PRICE_GROUP', priceGroupRef }) };
    const invalid = { _tag: 'INVALID' as const, reason: 'INVALID_CANONICAL_PRICE' as const, request };
    const conflict = {
      _tag: 'CONFLICT' as const,
      currentTruthRefs: [
        { priceRef, revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        {
          priceRef: { ...priceRef, resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        },
      ],
      evidence,
      reason: 'COMPETING_CURRENT_EXACT_PRICES' as const,
      request,
    };
    const unavailable = { _tag: 'UNAVAILABLE' as const, reason: 'EXACT_LOOKUP_UNAVAILABLE' as const, request };

    expect(
      Schema.is(ConfigurationErrorTagSchema)(
        decodeResolution({
          _tag: 'CONFIGURATION_ERROR',
          lookup: invalid,
          reason: invalid.reason,
          resolutionInput: assignedInput,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ConflictTagSchema)(
        decodeResolution({
          _tag: 'CONFLICT',
          lookup: conflict,
          reason: 'COMPETING_CURRENT_EXACT_PRICES',
          resolutionInput: assignedInput,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(IndeterminateTagSchema)(
        decodeResolution({
          _tag: 'INDETERMINATE',
          lookup: unavailable,
          reason: 'OWNER_STATE_UNAVAILABLE',
          resolutionInput: assignedInput,
        }),
      ),
    ).toBe(true);
    expect(() =>
      decodeResolution({
        _tag: 'CONFIGURATION_ERROR',
        reason: invalid.reason,
        resolutionInput: assignedInput,
      }),
    ).toThrow();
  });

  it('preserves native currency and rejects implicit FX or Storefront dimensions', () => {
    const groupKey = exactKey({ kind: 'PRICE_GROUP', priceGroupRef });
    expect(() =>
      decodeLookup({
        ...found(groupKey),
        priceRevision: { ...revision, monetaryAmount: { amount: '0', currencyCode: 'EUR' } },
      }),
    ).toThrow();
    expect(() =>
      decodeLookup({
        ...found(groupKey),
        request: {
          effectiveAt,
          exactKey: {
            ...groupKey,
            commercialScope: { ...groupKey.commercialScope, storefrontId: 'web-cz' },
          },
        },
      }),
    ).toThrow();
  });
});
