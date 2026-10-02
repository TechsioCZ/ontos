import type {
  ExactPriceConflictClaimant,
  ExactPriceConflictDiagnostic,
  ExactPriceLookupRequest,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceConflictClaimantSchema,
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupConflictSchema,
  ExactPriceLookupUnverifiableSchema,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceConflictResolutionSchema,
  ExactPriceIndeterminateResolutionSchema,
  ExactPriceResolutionInputSchema,
} from '@app/pricing-contracts/domain/exact-price-resolution';
import { DateTime, Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeExactPriceConflictRuntime } from '../../src/services/exact-price-conflict.service.ts';
import { makeExactPriceResolutionService } from '../../src/services/exact-price-resolution.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const observedAt = '2026-09-27T12:00:00.050Z';

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const selection = {
  productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
  variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
} as const;
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const basis = {
  catalogSelection: selection,
  commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: legalEntityId },
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
const resolutionInput = {
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
  resourceId: '12121212-1212-4212-8212-121212121212',
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: '13131313-1313-4313-8313-131313131313',
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId: supportRootRef.resourceId,
  tenantId,
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:764-runtime-acceptance';
const currencySupport = {
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionRef.resourceId,
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
const input = Schema.decodeSync(ExactPriceResolutionInputSchema)({ currencySupport, resolutionInput });
const freshSupport = {
  currentnessEvidence: {
    evaluatedAt: effectiveAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt: '2026-09-27T12:00:00.060Z',
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: currencySupport.effectivePeriod,
  generation: 7,
  observedAt,
  pricingRevision: currencySupport.pricingRevision,
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
} as const;

const exactKey = {
  ...basis,
  priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
} as const;
const makeRequest = (): ExactPriceLookupRequest => ({ effectiveAt, exactKey });
const lookupEvidence = {
  effectiveAt,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  ownerRevision: 'pricing-current-state:41',
} as const;

const claimant = (
  resourceId: string,
  revisionId: string,
  amount: string,
  scheduleRevision: number,
  provenanceRef: string,
): ExactPriceConflictClaimant =>
  Schema.decodeSync(ExactPriceConflictClaimantSchema)({
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    exactKey,
    priceRef: {
      moduleId: 'commerce.pricing',
      resourceId,
      resourceType: 'commerce.pricing.price',
      tenantId,
    },
    priceRevision: {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      monetaryAmount: { amount, currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      revision: scheduleRevision,
      revisionId,
    },
    priceScheduleRevisionId: `${resourceId.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    provenanceRefs: [provenanceRef],
    scheduleRevision,
  });

const diagnosticFor = (lookupRequest: ExactPriceLookupRequest): ExactPriceConflictDiagnostic =>
  Schema.decodeSync(ExactPriceConflictDiagnosticSchema)({
    _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
    claimants: [
      claimant(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '100',
        99,
        '02020202-0202-4202-8202-020202020202',
      ),
      claimant(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        '900',
        1,
        '01010101-0101-4101-8101-010101010101',
      ),
    ],
    evidence: lookupEvidence,
    reason: 'COMPETING_CURRENT_EXACT_PRICES',
    request: lookupRequest,
    verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET',
  });

describe('Issue #764 exact-key Price conflict runtime acceptance', () => {
  it('retains owner evidence while redacting the public conflict without a cheapest/latest winner', () => {
    const runtime = makeExactPriceConflictRuntime();
    const lookupRequest = makeRequest();
    const diagnostic = diagnosticFor(lookupRequest);
    const classified = runtime.classify(lookupRequest, diagnostic);

    expect(classified.ownerDiagnostic).toEqual(diagnostic);
    expect(Schema.is(ExactPriceLookupConflictSchema)(classified.lookup)).toBe(true);
    expect(classified.lookup).toMatchObject({
      currentTruthRefs: [
        { priceRef: { resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
        { priceRef: { resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      ],
    });
    expect(JSON.stringify(classified.lookup)).not.toContain('900');
    expect(JSON.stringify(classified.lookup)).not.toContain('100');
    expect(JSON.stringify(classified.lookup)).not.toContain('provenanceRefs');
  });

  it.effect('stops on a Group-key conflict and never consults the no-group fallback key', () =>
    Effect.gen(function* groupConflict() {
      const requests: ExactPriceLookupRequest[] = [];
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current' as const, current: freshSupport }),
        lookupExact: (lookupRequest) => {
          requests.push(lookupRequest);
          return Effect.succeed(diagnosticFor(lookupRequest));
        },
      });

      const result = yield* service.resolve(input, {
        legalEntityId,
        tenantId,
        trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
      });

      expect(Schema.is(ExactPriceConflictResolutionSchema)(result)).toBe(true);
      expect(
        Match.value(result.path).pipe(
          Match.tag('CONFLICT', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.exactKey.priceGroupSelector.kind).toBe('PRICE_GROUP');
    }),
  );

  it('maps request-mismatched owner conflict evidence to an unverifiable lookup, never a fabricated conflict', () => {
    const runtime = makeExactPriceConflictRuntime();
    const lookupRequest = makeRequest();
    const mismatchedRequest = {
      ...lookupRequest,
      exactKey: {
        ...lookupRequest.exactKey,
        commercialScope: { ...lookupRequest.exactKey.commercialScope, marketId: 'SK' },
      },
    };
    const mismatched = runtime.classify(mismatchedRequest, diagnosticFor(lookupRequest));
    expect(Schema.is(ExactPriceLookupUnverifiableSchema)(mismatched.lookup)).toBe(true);
    expect(mismatched.lookup).toMatchObject({ reason: 'EXACT_KEY_BINDING_UNVERIFIABLE' });
  });

  it.effect('maps owner-unverifiable Current-set evidence to PRICING_INDETERMINATE without fallback', () =>
    Effect.gen(function* unverifiableCurrentSet() {
      const requests: ExactPriceLookupRequest[] = [];
      const service = makeExactPriceResolutionService({
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current' as const, current: freshSupport }),
        lookupExact: (lookupRequest) => {
          requests.push(lookupRequest);
          return Effect.succeed({
            _tag: 'UNVERIFIABLE' as const,
            reason: 'SET_COMPLETENESS_UNVERIFIABLE' as const,
            request: lookupRequest,
          });
        },
      });

      const result = yield* service.resolve(input, {
        legalEntityId,
        tenantId,
        trustedOperationAt: DateTime.makeUnsafe(effectiveAt),
      });

      expect(Schema.is(ExactPriceIndeterminateResolutionSchema)(result)).toBe(true);
      expect(
        Match.value(result.path).pipe(
          Match.tag('INDETERMINATE', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.exactKey.priceGroupSelector.kind).toBe('PRICE_GROUP');
    }),
  );
});
