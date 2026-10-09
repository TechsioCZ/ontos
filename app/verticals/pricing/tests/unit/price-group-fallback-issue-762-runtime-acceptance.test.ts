import type {
  PriceGroupFallbackExactLookupRequest,
  PriceGroupFallbackExactLookupResult,
  PriceGroupFallbackResolution,
  PriceGroupFallbackResolutionInput,
} from '@app/pricing-contracts/domain/price-group-fallback';
import { Effect, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PriceGroupFallbackExactLookupPort } from '../../src/services/price-group-fallback.service.ts';
import { makePriceGroupFallbackResolver } from '../../src/services/price-group-fallback.service.ts';

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
const assignedInput = { _tag: 'ASSIGNED', effectiveAt, interpretation: assignedInterpretation } as const;
const ownerNoneInput = {
  _tag: 'OWNER_NONE',
  effectiveAt,
  interpretation: noneInterpretation,
  ownerResolution: { effectiveAt, profile, resolution: { _tag: 'NONE' } },
} as const;
const guestInput = { _tag: 'GUEST', basis, effectiveAt } as const;

const currentEvidence = {
  effectiveAt,
  observedAt: '2026-03-01T00:00:01.000Z',
  ownerRevision: 'pricing-price-set:17',
} as const;
const priceRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
});
const found = (request: PriceGroupFallbackExactLookupRequest, amount: string): PriceGroupFallbackExactLookupResult => ({
  _tag: 'FOUND',
  evidence: currentEvidence,
  priceRef: priceRef('99999999-9999-4999-8999-999999999999'),
  priceRevision: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    monetaryAmount: { amount, currencyCode: request.exactKey.currencyCode },
    monetaryBoundary: 'PRE_TAX',
    revision: 1,
    revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  request,
});
const absent = (request: PriceGroupFallbackExactLookupRequest): PriceGroupFallbackExactLookupResult => ({
  _tag: 'ABSENT',
  evidence: currentEvidence,
  request,
});
const lookupPort = (
  respond: (request: PriceGroupFallbackExactLookupRequest, call: number) => PriceGroupFallbackExactLookupResult,
) => {
  const requests: PriceGroupFallbackExactLookupRequest[] = [];
  const lookup: PriceGroupFallbackExactLookupPort = {
    lookup: (request) => {
      requests.push(request);
      return Effect.succeed(respond(request, requests.length));
    },
  };
  return { lookup, requests };
};

const requireFallback = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected assigned-Group absence fallback');
    }),
  );
const requireGroupPrice = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('GROUP_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected Group Price resolution');
    }),
  );
const requireNoApplicable = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_APPLICABLE_PRICE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected no-applicable-price resolution');
    }),
  );
const requireNoGroupNone = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_NONE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected owner-NONE no-group resolution');
    }),
  );
const requireNoGroupGuest = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('NO_GROUP_GUEST', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected Guest no-group resolution');
    }),
  );
const requireConfigurationError = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('CONFIGURATION_ERROR', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected configuration-error resolution');
    }),
  );
const requireConflict = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('CONFLICT', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected conflict resolution');
    }),
  );
const requireIndeterminate = (resolution: PriceGroupFallbackResolution) =>
  Match.value(resolution).pipe(
    Match.tag('INDETERMINATE', (value) => value),
    Match.orElse(() => {
      throw new Error('Expected indeterminate resolution');
    }),
  );

describe('Issue #762 exact Price Group fallback runtime acceptance', () => {
  it.effect('uses an assigned Group Price regardless of it being more expensive or zero', () =>
    Effect.gen(function* resolveGroupPrice() {
      for (const amount of ['200', '0']) {
        const { lookup, requests } = lookupPort((request) => found(request, amount));
        const result = requireGroupPrice(yield* makePriceGroupFallbackResolver(lookup).resolve(assignedInput));

        expect(result.usedPrice.priceRevision.monetaryAmount.amount).toBe(amount);
        expect(result.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.exactKey.priceGroupSelector).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
      }
    }),
  );

  it.effect('falls back only after exact assigned-Group absence and preserves the Group audience', () =>
    Effect.gen(function* resolveFallback() {
      const { lookup, requests } = lookupPort((request, call) =>
        call === 1 ? absent(request) : found(request, '100'),
      );
      const result = requireFallback(yield* makePriceGroupFallbackResolver(lookup).resolve(assignedInput));

      expect(requests).toHaveLength(2);
      expect(requests[0]?.exactKey.priceGroupSelector).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
      expect(requests[1]?.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
      expect(result.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
      expect(result.groupAbsence.request).toEqual(requests[0]);
      expect(result.usedPrice.request).toEqual(requests[1]);
    }),
  );

  it.effect('returns no applicable price only after exhausting the permitted exact path', () =>
    Effect.gen(function* resolveAbsent() {
      const assignedLookup = lookupPort((request) => absent(request));
      const assigned = requireNoApplicable(
        yield* makePriceGroupFallbackResolver(assignedLookup.lookup).resolve(assignedInput),
      );
      expect(assignedLookup.requests).toHaveLength(2);
      expect(assigned.groupAbsence).toBeDefined();
      expect(assigned.noGroupAbsence.request.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });

      for (const input of [ownerNoneInput, guestInput]) {
        const directLookup = lookupPort((request) => absent(request));
        const direct = requireNoApplicable(yield* makePriceGroupFallbackResolver(directLookup.lookup).resolve(input));
        expect(directLookup.requests).toHaveLength(1);
        expect(directLookup.requests[0]?.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
        expect(direct.groupAbsence).toBeUndefined();
      }
    }),
  );

  it.effect('sends owner NONE and Guest/no-profile directly to the exact no-group key', () =>
    Effect.gen(function* resolveDirectNoGroup() {
      expect('profile' in guestInput).toBe(false);
      expect('ownerResolution' in guestInput).toBe(false);

      const ownerNoneLookup = lookupPort((request) => found(request, '100'));
      const ownerNone = requireNoGroupNone(
        yield* makePriceGroupFallbackResolver(ownerNoneLookup.lookup).resolve(ownerNoneInput),
      );
      expect(ownerNone.usedPrice.request.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
      expect(ownerNoneLookup.requests).toHaveLength(1);

      const guestLookup = lookupPort((request) => found(request, '100'));
      const guest = requireNoGroupGuest(yield* makePriceGroupFallbackResolver(guestLookup.lookup).resolve(guestInput));
      expect(guest.usedPrice.request.exactKey.priceGroupSelector).toEqual({ kind: 'NO_GROUP' });
      expect(guestLookup.requests).toHaveLength(1);
    }),
  );

  it.effect('never converts conflicting, invalid, unavailable, or unverifiable exact state into absence', () =>
    Effect.gen(function* rejectTerminalLookupState() {
      const terminalCases: readonly {
        readonly assertResolution: (resolution: PriceGroupFallbackResolution) => void;
        readonly respond: (request: PriceGroupFallbackExactLookupRequest) => PriceGroupFallbackExactLookupResult;
      }[] = [
        {
          assertResolution: (resolution) => {
            expect(requireConflict(resolution).reason).toBe('COMPETING_CURRENT_EXACT_PRICES');
          },
          respond: (request) => ({
            _tag: 'CONFLICT',
            currentTruthRefs: [
              {
                priceRef: priceRef('99999999-9999-4999-8999-999999999999'),
                revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              },
              {
                priceRef: priceRef('e0000000-0000-4000-8000-000000000001'),
                revisionId: 'e0000000-0000-4000-8000-000000000002',
              },
            ],
            evidence: currentEvidence,
            reason: 'COMPETING_CURRENT_EXACT_PRICES',
            request,
          }),
        },
        {
          assertResolution: (resolution) => {
            expect(requireConfigurationError(resolution).reason).toBe('INVALID_CANONICAL_PRICE');
          },
          respond: (request) => ({ _tag: 'INVALID', reason: 'INVALID_CANONICAL_PRICE', request }),
        },
        {
          assertResolution: (resolution) => {
            expect(requireIndeterminate(resolution).reason).toBe('OWNER_STATE_UNAVAILABLE');
          },
          respond: (request) => ({ _tag: 'UNAVAILABLE', reason: 'EXACT_LOOKUP_UNAVAILABLE', request }),
        },
        {
          assertResolution: (resolution) => {
            expect(requireIndeterminate(resolution).reason).toBe('OWNER_STATE_UNVERIFIABLE');
          },
          respond: (request) => ({ _tag: 'UNVERIFIABLE', reason: 'CURRENTNESS_UNVERIFIABLE', request }),
        },
      ];

      for (const { assertResolution, respond } of terminalCases) {
        const { lookup, requests } = lookupPort(respond);
        const result = yield* makePriceGroupFallbackResolver(lookup).resolve(assignedInput);
        assertResolution(result);
        expect(requests).toHaveLength(1);
      }
    }),
  );

  it.effect(
    'never looks up a fallback for retired/broken, inconsistent, unavailable, or unverifiable owner state',
    () =>
      Effect.gen(function* rejectBlockedOwnerState() {
        const blockedCases: readonly [
          PriceGroupFallbackResolutionInput,
          (resolution: PriceGroupFallbackResolution) => void,
        ][] = [
          [
            {
              _tag: 'BLOCKED',
              effectiveAt,
              interpretation: {
                _tag: 'BROKEN',
                assignmentResolution: {
                  _tag: 'BROKEN',
                  assignmentRef: assignmentResolution.assignmentRef,
                  assignmentRevision: 3,
                  catalogRevision: 7,
                  priceGroupRef,
                  reason: 'RETIRED',
                },
                basis,
                reason: 'RETIRED',
                source: 'COMMERCE_ASSIGNMENT',
              },
            },
            (resolution) => {
              expect(requireConfigurationError(resolution).reason).toBe('BROKEN_ASSIGNMENT');
            },
          ],
          [
            {
              _tag: 'BLOCKED',
              effectiveAt,
              interpretation: {
                _tag: 'INCONSISTENT',
                assignmentResolution: { _tag: 'INCONSISTENT', currentAssignmentCount: 2 },
                basis,
                currentAssignmentCount: 2,
              },
            },
            (resolution) => {
              expect(requireConflict(resolution).reason).toBe('INCONSISTENT_ASSIGNMENT');
            },
          ],
          [
            {
              _tag: 'BLOCKED',
              effectiveAt,
              interpretation: {
                _tag: 'UNAVAILABLE',
                basis,
                owner: 'COMMERCE_ASSIGNMENT',
                reason: 'owner unavailable',
              },
            },
            (resolution) => {
              expect(requireIndeterminate(resolution).reason).toBe('OWNER_STATE_UNAVAILABLE');
            },
          ],
          [
            {
              _tag: 'BLOCKED',
              effectiveAt,
              interpretation: {
                _tag: 'UNVERIFIABLE',
                basis,
                owner: 'PRICE_GROUP_COMPATIBILITY',
                reason: 'DEPENDENCY_EVIDENCE_UNVERIFIABLE',
              },
            },
            (resolution) => {
              expect(requireIndeterminate(resolution).reason).toBe('OWNER_STATE_UNVERIFIABLE');
            },
          ],
        ];

        for (const [input, assertResolution] of blockedCases) {
          const { lookup, requests } = lookupPort((request) => absent(request));
          const result = yield* makePriceGroupFallbackResolver(lookup).resolve(input);
          assertResolution(result);
          expect(requests).toHaveLength(0);
        }
      }),
  );

  it.effect('preserves exact Variant, Market, SLE, native currency, and basis without Storefront or FX', () =>
    Effect.gen(function* preserveExactDimensions() {
      const eurAssignedInput = {
        ...assignedInput,
        interpretation: {
          ...assignedInput.interpretation,
          basis: { ...basis, currencyCode: 'EUR' },
        },
      } as const;
      const { lookup, requests } = lookupPort((request) => absent(request));
      const result = requireNoApplicable(yield* makePriceGroupFallbackResolver(lookup).resolve(eurAssignedInput));

      expect(result.groupAbsence).toBeDefined();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.exactKey.catalogSelection.variantRef).toEqual(basis.catalogSelection.variantRef);
        expect(request.exactKey.commercialScope).toEqual(basis.commercialScope);
        expect(request.exactKey.currencyCode).toBe('EUR');
        expect(request.exactKey.unitBasis).toEqual(basis.unitBasis);
        expect('storefrontId' in request.exactKey).toBe(false);
      }
    }),
  );
});
