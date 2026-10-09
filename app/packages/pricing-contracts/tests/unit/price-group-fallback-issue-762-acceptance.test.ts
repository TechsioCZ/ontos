import type {
  PriceGroupFallbackResolution,
  PriceGroupFallbackResolutionInput,
} from '../../src/domain/price-group-fallback.ts';
import {
  PriceGroupFallbackExactLookupResultSchema,
  PriceGroupFallbackResolutionInputSchema,
  PriceGroupFallbackResolutionSchema,
} from '../../src/domain/price-group-fallback.ts';
import { Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-03-01T00:00:00.000Z';
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
const basis = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
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
  verifiedAt: '2026-03-01T00:00:01.000Z',
} as const;
const assignmentResolution = {
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
const assignedInterpretation = {
  _tag: 'ASSIGNED',
  assignmentResolution,
  basis,
  compatibilityEvidence,
  discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
  priceGroupRef,
  priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
} as const;
const noneInterpretation = {
  _tag: 'NONE',
  assignmentResolution: { _tag: 'NONE' },
  basis,
  discountAudience: { kind: 'NONE' },
  priceSelector: { kind: 'NO_GROUP' },
} as const;
const ownerNoneResolution = {
  effectiveAt,
  profile,
  resolution: { _tag: 'NONE' },
} as const;
const assignedInput = { _tag: 'ASSIGNED', effectiveAt, interpretation: assignedInterpretation } as const;
const ownerNoneInput = {
  _tag: 'OWNER_NONE',
  effectiveAt,
  interpretation: noneInterpretation,
  ownerResolution: ownerNoneResolution,
} as const;
const guestInput = { _tag: 'GUEST', basis, effectiveAt } as const;

const priceRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
});
const exactKey = (
  priceGroupSelector:
    | { readonly kind: 'NO_GROUP' }
    | { readonly kind: 'PRICE_GROUP'; readonly priceGroupRef: typeof priceGroupRef },
  overrides = {},
) => ({
  catalogSelection: basis.catalogSelection,
  commercialScope: basis.commercialScope,
  currencyCode: basis.currencyCode,
  priceGroupSelector,
  unitBasis: basis.unitBasis,
  ...overrides,
});
const request = (priceGroupSelector: Parameters<typeof exactKey>[0], overrides = {}) => ({
  effectiveAt,
  exactKey: exactKey(priceGroupSelector, overrides),
});
const evidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-04-01T00:00:00.000Z',
  observedAt: '2026-03-01T00:00:01.000Z',
  ownerRevision: 'pricing-price-set:17',
} as const;
const found = (
  amount: string,
  priceGroupSelector: Parameters<typeof exactKey>[0],
  resourceId = '99999999-9999-4999-8999-999999999999',
  overrides = {},
) => ({
  _tag: 'FOUND',
  evidence,
  priceRef: priceRef(resourceId),
  priceRevision: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    monetaryAmount: { amount, currencyCode: basis.currencyCode },
    monetaryBoundary: 'PRE_TAX',
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  request: request(priceGroupSelector, overrides),
});
const absent = (priceGroupSelector: Parameters<typeof exactKey>[0], overrides = {}) => ({
  _tag: 'ABSENT',
  evidence,
  request: request(priceGroupSelector, overrides),
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

const requireGroupPrice = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('GROUP_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected a Group Price resolution');
    }),
  );
const requireFallback = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected an assigned-Group absence fallback resolution');
    }),
  );
const requireNoApplicable = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_APPLICABLE_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected a no-applicable-price resolution');
    }),
  );
const requireNoGroupNone = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_NONE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected an owner-NONE no-group resolution');
    }),
  );
const requireNoGroupGuest = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_GUEST', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected a Guest no-group resolution');
    }),
  );
const requireOwnerNoneInput = (input: PriceGroupFallbackResolutionInput) =>
  Match.value(input).pipe(
    Match.tag('OWNER_NONE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected owner-NONE input');
    }),
  );
const requireGuestInput = (input: PriceGroupFallbackResolutionInput) =>
  Match.value(input).pipe(
    Match.tag('GUEST', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected Guest input');
    }),
  );

describe('Issue #762 exact Price Group fallback contract acceptance', () => {
  it('keeps the assigned Group Price even when it is more expensive or exactly zero', () => {
    for (const amount of ['200', '0']) {
      const usedPrice = found(amount, { kind: 'PRICE_GROUP', priceGroupRef });
      const decoded = requireGroupPrice(
        decodeResolution({
          _tag: 'GROUP_PRICE',
          discountAudience: assignedInterpretation.discountAudience,
          resolutionInput: assignedInput,
          usedPrice,
        }),
      );

      expect(decoded.usedPrice.priceRevision.monetaryAmount.amount).toBe(amount);
      expect(decoded.usedPrice.request.exactKey.priceGroupSelector).toEqual({
        kind: 'PRICE_GROUP',
        priceGroupRef,
      });
    }
  });

  it('preserves exact Group absence before no-group resolution and retains the real Group audience', () => {
    const groupAbsence = absent({ kind: 'PRICE_GROUP', priceGroupRef });
    const usedPrice = found('150', { kind: 'NO_GROUP' });
    const decoded = requireFallback(
      decodeResolution({
        _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
        discountAudience: assignedInterpretation.discountAudience,
        groupAbsence,
        resolutionInput: assignedInput,
        usedPrice,
      }),
    );

    expect(decoded.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
    expect(decoded.groupAbsence.request.exactKey.priceGroupSelector).toEqual({
      kind: 'PRICE_GROUP',
      priceGroupRef,
    });
    expect(decoded.usedPrice.request.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
  });

  it('requires both exact absences for assigned no-applicable, but only no-group absence for NONE and Guest', () => {
    expect(
      requireNoApplicable(
        decodeResolution({
          _tag: 'NO_APPLICABLE_PRICE',
          groupAbsence: absent({ kind: 'PRICE_GROUP', priceGroupRef }),
          noGroupAbsence: absent({ kind: 'NO_GROUP' }),
          resolutionInput: assignedInput,
        }),
      ).groupAbsence,
    ).toBeDefined();

    for (const resolutionInput of [ownerNoneInput, guestInput]) {
      expect(
        requireNoApplicable(
          decodeResolution({
            _tag: 'NO_APPLICABLE_PRICE',
            noGroupAbsence: absent({ kind: 'NO_GROUP' }),
            resolutionInput,
          }),
        ).groupAbsence,
      ).toBeUndefined();
    }

    expect(() =>
      decodeResolution({
        _tag: 'NO_APPLICABLE_PRICE',
        noGroupAbsence: absent({ kind: 'NO_GROUP' }),
        resolutionInput: assignedInput,
      }),
    ).toThrow();
  });

  it('keeps owner NONE and Guest/no-profile as separate direct no-group authorities', () => {
    expect(requireOwnerNoneInput(decodeInput(ownerNoneInput)).ownerResolution).toEqual(ownerNoneResolution);
    expect(requireGuestInput(decodeInput(guestInput)).basis).toEqual(basis);
    expect(() => decodeInput({ ...guestInput, profile })).toThrow();

    expect(
      requireNoGroupNone(
        decodeResolution({
          _tag: 'NO_GROUP_NONE',
          discountAudience: { kind: 'NONE' },
          resolutionInput: ownerNoneInput,
          usedPrice: found('100', { kind: 'NO_GROUP' }),
        }),
      ).usedPrice.request.exactKey.priceGroupSelector,
    ).toEqual({ kind: 'NO_GROUP' });
    expect(
      requireNoGroupGuest(
        decodeResolution({
          _tag: 'NO_GROUP_GUEST',
          discountAudience: { kind: 'NONE' },
          resolutionInput: guestInput,
          usedPrice: found('100', { kind: 'NO_GROUP' }),
        }),
      ).usedPrice.request.exactKey.priceGroupSelector,
    ).toEqual({ kind: 'NO_GROUP' });
  });

  it('never admits Storefront, cross-currency substitution, or a changed exact lookup dimension', () => {
    expect(() =>
      decodeLookup({
        ...found('100', { kind: 'NO_GROUP' }),
        request: {
          ...request({ kind: 'NO_GROUP' }),
          exactKey: { ...exactKey({ kind: 'NO_GROUP' }), storefrontId: 'storefront-a' },
        },
      }),
    ).toThrow();

    expect(() =>
      decodeLookup({
        ...found('100', { kind: 'NO_GROUP' }),
        priceRevision: {
          ...found('100', { kind: 'NO_GROUP' }).priceRevision,
          monetaryAmount: { amount: '100', currencyCode: 'EUR' },
        },
      }),
    ).toThrow();

    const mutations = [
      {
        catalogSelection: {
          ...basis.catalogSelection,
          variantRef: { ...basis.catalogSelection.variantRef, resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
        },
      },
      { commercialScope: { ...basis.commercialScope, marketId: 'other-market' } },
      { commercialScope: { ...basis.commercialScope, sellingLegalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      { currencyCode: 'EUR' },
      { unitBasis: { ...basis.unitBasis, quantity: '2' } },
    ];
    for (const mutation of mutations) {
      expect(() =>
        decodeResolution({
          _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE',
          discountAudience: assignedInterpretation.discountAudience,
          groupAbsence: absent({ kind: 'PRICE_GROUP', priceGroupRef }),
          resolutionInput: assignedInput,
          usedPrice: found('100', { kind: 'NO_GROUP' }, undefined, mutation),
        }),
      ).toThrow();
    }
  });

  it('preserves generalized native-currency keys without activating implicit FX', () => {
    const eurKey = exactKey({ kind: 'NO_GROUP' }, { currencyCode: 'EUR' });
    const eurFound = {
      ...found('10', { kind: 'NO_GROUP' }),
      priceRevision: {
        ...found('10', { kind: 'NO_GROUP' }).priceRevision,
        monetaryAmount: { amount: '10', currencyCode: 'EUR' },
      },
      request: { effectiveAt, exactKey: eurKey },
    };
    expect(decodeLookup(eurFound)).toMatchObject({
      priceRevision: { monetaryAmount: { currencyCode: 'EUR' } },
      request: { exactKey: { currencyCode: 'EUR' } },
    });
    expect(() =>
      decodeLookup({
        ...eurFound,
        priceRevision: {
          ...eurFound.priceRevision,
          monetaryAmount: { amount: '250', currencyCode: 'CZK' },
        },
      }),
    ).toThrow();
  });
});
