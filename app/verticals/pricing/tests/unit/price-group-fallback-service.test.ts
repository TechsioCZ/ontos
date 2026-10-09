import type {
  PriceGroupFallbackExactLookupRequest,
  PriceGroupFallbackExactLookupResult,
  PriceGroupFallbackResolution,
  PriceGroupFallbackResolutionInput,
} from '@app/pricing-contracts/domain/price-group-fallback';
import { Effect, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makePriceGroupFallbackResolver } from '../../src/services/price-group-fallback.service.ts';
import type { PriceGroupFallbackExactLookupPort } from '../../src/services/price-group-fallback.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const assignmentRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
} as const;
const basis = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '70000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2B',
    marketId: 'CZ',
    sellingLegalEntityId: '80000000-0000-4000-8000-000000000001',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '90000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
} as const;
const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: 'a0000000-0000-4000-8000-000000000001',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: effectiveAt,
} as const;
const assignedResolution = {
  _tag: 'ASSIGNED',
  assignmentRef,
  assignmentRevision: 2,
  compatibility: compatibilityEvidence,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef,
} as const;
const assignedInput: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'ASSIGNED' }> = {
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
};
const noneInterpretation = {
  _tag: 'NONE',
  assignmentResolution: { _tag: 'NONE' },
  basis,
  discountAudience: { kind: 'NONE' },
  priceSelector: { kind: 'NO_GROUP' },
} as const;
const ownerNoneInput: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'OWNER_NONE' }> = {
  _tag: 'OWNER_NONE',
  effectiveAt,
  interpretation: noneInterpretation,
  ownerResolution: { effectiveAt, profile, resolution: { _tag: 'NONE' } },
};
const guestInput: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'GUEST' }> = {
  _tag: 'GUEST',
  basis,
  effectiveAt,
};

const evidence = {
  effectiveAt,
  observedAt: effectiveAt,
  ownerRevision: 'pricing-price-set:7',
} as const;

const found = (
  request: PriceGroupFallbackExactLookupRequest,
  amount = '900',
): Extract<PriceGroupFallbackExactLookupResult, { readonly _tag: 'FOUND' }> => ({
  _tag: 'FOUND',
  evidence,
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId:
      request.exactKey.priceGroupSelector.kind === 'PRICE_GROUP'
        ? 'b0000000-0000-4000-8000-000000000001'
        : 'c0000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount, currencyCode: request.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX',
    revision: 1,
    revisionId: 'd0000000-0000-4000-8000-000000000001',
  },
  request,
});

const absent = (
  request: PriceGroupFallbackExactLookupRequest,
): Extract<PriceGroupFallbackExactLookupResult, { readonly _tag: 'ABSENT' }> => ({
  _tag: 'ABSENT',
  evidence,
  request,
});

const serviceWith = (
  resolve: (request: PriceGroupFallbackExactLookupRequest, call: number) => PriceGroupFallbackExactLookupResult,
) => {
  const calls: PriceGroupFallbackExactLookupRequest[] = [];
  const lookup: PriceGroupFallbackExactLookupPort = {
    lookup: (request) => {
      calls.push(request);
      return Effect.succeed(resolve(request, calls.length));
    },
  };
  return { calls, service: makePriceGroupFallbackResolver(lookup) };
};

const resolutionKind = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('GROUP_PRICE', () => 'GROUP_PRICE' as const),
    Match.tag('NO_GROUP_NONE', () => 'NO_GROUP_NONE' as const),
    Match.tag('NO_GROUP_GUEST', () => 'NO_GROUP_GUEST' as const),
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', () => 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE' as const),
    Match.tag('NO_APPLICABLE_PRICE', () => 'NO_APPLICABLE_PRICE' as const),
    Match.tag('CONFIGURATION_ERROR', () => 'CONFIGURATION_ERROR' as const),
    Match.tag('CONFLICT', () => 'CONFLICT' as const),
    Match.tag('INDETERMINATE', () => 'INDETERMINATE' as const),
    Match.exhaustive,
  );

const requireGroupPrice = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('GROUP_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected exact Group Price resolution');
    }),
  );

const requireAssignedFallback = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected assigned Group absence followed by no-group resolution');
    }),
  );

const requireNoApplicablePrice = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('NO_APPLICABLE_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected no applicable Price');
    }),
  );

const requireIndeterminate = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('INDETERMINATE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected indeterminate Price lookup');
    }),
  );

const requireGuestPrice = (result: PriceGroupFallbackResolution) =>
  Match.value(result).pipe(
    Match.tag('NO_GROUP_GUEST', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected Guest no-group Price');
    }),
  );

describe('Price Group exact fallback resolver', () => {
  it.effect('uses the exact assigned Group Price even when its valid amount is zero', () =>
    Effect.gen(function* assignedGroupPrice() {
      const { calls, service } = serviceWith((request) => found(request, '0'));

      const result = yield* service.resolve(assignedInput);

      expect(requireGroupPrice(result)).toMatchObject({
        discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
        usedPrice: { priceRevision: { monetaryAmount: { amount: '0', currencyCode: 'CZK' } } },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.exactKey).toEqual({
        catalogSelection: basis.catalogSelection,
        commercialScope: basis.commercialScope,
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
        unitBasis: basis.unitBasis,
      });
    }),
  );

  it.effect('falls back to the matching no-group key only after authoritative exact Group absence', () =>
    Effect.gen(function* assignedFallback() {
      const { calls, service } = serviceWith((request, call) => (call === 1 ? absent(request) : found(request, '100')));

      const result = yield* service.resolve(assignedInput);

      expect(requireAssignedFallback(result)).toMatchObject({
        discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
        usedPrice: { priceRevision: { monetaryAmount: { amount: '100', currencyCode: 'CZK' } } },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.exactKey).toEqual({
        ...calls[0]?.exactKey,
        priceGroupSelector: { kind: 'NO_GROUP' },
      });
    }),
  );

  it.effect('sends owner NONE and Guest directly to the same exact no-group Price key', () =>
    Effect.gen(function* directNoGroup() {
      const owner = serviceWith((request) => found(request));
      const guest = serviceWith((request) => found(request));

      const ownerResult = yield* owner.service.resolve(ownerNoneInput);
      const guestResult = yield* guest.service.resolve(guestInput);

      expect(resolutionKind(ownerResult)).toBe('NO_GROUP_NONE');
      expect(resolutionKind(guestResult)).toBe('NO_GROUP_GUEST');
      expect(owner.calls).toHaveLength(1);
      expect(guest.calls).toHaveLength(1);
      expect(owner.calls[0]).toEqual(guest.calls[0]);
      expect(owner.calls[0]?.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
    }),
  );

  it.effect('returns no applicable Price only after the complete permitted assigned path is proven absent', () =>
    Effect.gen(function* noApplicablePrice() {
      const { calls, service } = serviceWith(absent);

      const result = yield* service.resolve(assignedInput);

      expect(requireNoApplicablePrice(result).groupAbsence).toBeDefined();
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect('never falls back on conflict, invalidity, unavailability, or unverifiable evidence', () =>
    Effect.gen(function* failClosedLookupOutcomes() {
      const cases = [
        {
          expected: 'CONFLICT',
          result: (request: PriceGroupFallbackExactLookupRequest): PriceGroupFallbackExactLookupResult => ({
            _tag: 'CONFLICT',
            currentTruthRefs: [
              {
                priceRef: found(request).priceRef,
                revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              },
              {
                priceRef: {
                  ...found(request).priceRef,
                  resourceId: 'e0000000-0000-4000-8000-000000000001',
                },
                revisionId: 'e0000000-0000-4000-8000-000000000002',
              },
            ],
            evidence,
            reason: 'COMPETING_CURRENT_EXACT_PRICES',
            request,
          }),
        },
        {
          expected: 'CONFIGURATION_ERROR',
          result: (request: PriceGroupFallbackExactLookupRequest): PriceGroupFallbackExactLookupResult => ({
            _tag: 'INVALID',
            reason: 'INVALID_CANONICAL_PRICE',
            request,
          }),
        },
        {
          expected: 'INDETERMINATE',
          result: (request: PriceGroupFallbackExactLookupRequest): PriceGroupFallbackExactLookupResult => ({
            _tag: 'UNAVAILABLE',
            reason: 'EXACT_LOOKUP_UNAVAILABLE',
            request,
          }),
        },
        {
          expected: 'INDETERMINATE',
          result: (request: PriceGroupFallbackExactLookupRequest): PriceGroupFallbackExactLookupResult => ({
            _tag: 'UNVERIFIABLE',
            reason: 'SET_COMPLETENESS_UNVERIFIABLE',
            request,
          }),
        },
      ] as const;

      for (const candidate of cases) {
        const { calls, service } = serviceWith(candidate.result);
        const result = yield* service.resolve(assignedInput);
        expect(resolutionKind(result)).toBe(candidate.expected);
        expect(calls).toHaveLength(1);
      }
    }),
  );

  it.effect('blocks broken and inconsistent assignment state without any Price lookup', () =>
    Effect.gen(function* blockedAssignment() {
      const { calls, service } = serviceWith((request) => found(request));
      const broken: PriceGroupFallbackResolutionInput = {
        _tag: 'BLOCKED',
        effectiveAt,
        interpretation: {
          _tag: 'BROKEN',
          assignmentResolution: {
            _tag: 'BROKEN',
            assignmentRef,
            assignmentRevision: 2,
            catalogRevision: 7,
            priceGroupRef,
            reason: 'RETIRED',
          },
          basis,
          reason: 'RETIRED',
          source: 'COMMERCE_ASSIGNMENT',
        },
      };
      const inconsistent: PriceGroupFallbackResolutionInput = {
        _tag: 'BLOCKED',
        effectiveAt,
        interpretation: {
          _tag: 'INCONSISTENT',
          assignmentResolution: { _tag: 'INCONSISTENT', currentAssignmentCount: 2 },
          basis,
          currentAssignmentCount: 2,
        },
      };

      expect(resolutionKind(yield* service.resolve(broken))).toBe('CONFIGURATION_ERROR');
      expect(resolutionKind(yield* service.resolve(inconsistent))).toBe('CONFLICT');
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect('rejects a well-formed lookup response echoed for a different exact key', () =>
    Effect.gen(function* mismatchedOwnerResponse() {
      const { calls, service } = serviceWith((request) =>
        found({
          ...request,
          exactKey: { ...request.exactKey, currencyCode: 'EUR' },
        }),
      );

      const result = yield* service.resolve(assignedInput);

      expect(requireIndeterminate(result).reason).toBe('OWNER_STATE_UNVERIFIABLE');
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect('preserves a generalized native currency key without cross-currency fallback or FX', () =>
    Effect.gen(function* nativeCurrencyIsolation() {
      const eurInput: typeof guestInput = { ...guestInput, basis: { ...basis, currencyCode: 'EUR' } };
      const { calls, service } = serviceWith((request) => found(request, '25'));

      const result = yield* service.resolve(eurInput);

      expect(requireGuestPrice(result)).toMatchObject({
        usedPrice: { priceRevision: { monetaryAmount: { amount: '25', currencyCode: 'EUR' } } },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.exactKey.currencyCode).toBe('EUR');
    }),
  );
});
