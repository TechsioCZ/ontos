import type {
  ExactPriceConflictDiagnostic,
  ExactPriceLookupRequest,
  ExactPriceOwnerLookupResult,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import { ExactPriceLookupRequestSchema } from '@app/pricing-contracts/domain/exact-price-lookup';
import { Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeExactPriceConflictRuntime } from '../../src/services/exact-price-conflict.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectiveAt = '2026-09-27T12:00:00.000Z';
const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const request = Schema.decodeUnknownSync(ExactPriceLookupRequestSchema)({
  effectiveAt,
  exactKey: {
    catalogSelection: {
      productRef: catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product'),
      variantRef: catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant'),
    },
    commercialScope: {
      channelId: 'B2C',
      marketId: 'CZ',
      sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: {
      quantity: '1',
      unitRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit'),
    },
  },
});
const { exactKey } = request;
const evidence = {
  effectiveAt,
  observedAt: '2026-09-27T12:00:00.050Z',
  ownerRevision: 'pricing-exact-key-current:v2:41',
} as const;

const claimant = (
  priceId: string,
  revisionId: string,
  provenanceRef: string,
): ExactPriceConflictDiagnostic['claimants'][number] => ({
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  exactKey,
  priceRef: {
    moduleId: 'commerce.pricing',
    resourceId: priceId,
    resourceType: 'commerce.pricing.price',
    tenantId,
  },
  priceRevision: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    monetaryAmount: { amount: '900', currencyCode: 'CZK' },
    monetaryBoundary: 'PRE_TAX',
    revision: 2,
    revisionId,
  },
  priceScheduleRevisionId: revisionId,
  provenanceRefs: [provenanceRef],
  scheduleRevision: 2,
});

const firstClaimant = claimant(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '10101010-1010-4010-8010-101010101010',
);
const secondClaimant = claimant(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '20202020-2020-4020-8020-202020202020',
);
const diagnostic: ExactPriceConflictDiagnostic = {
  _tag: 'EXACT_PRICE_CONFLICT_DIAGNOSTIC',
  claimants: [firstClaimant, secondClaimant],
  evidence,
  reason: 'COMPETING_CURRENT_EXACT_PRICES',
  request,
  verification: 'OWNER_VERIFIED_COMPLETE_CURRENT_SET',
};

describe('exact Price conflict runtime', () => {
  it('retains authorized equal-amount claimants while returning only redacted public identities', () => {
    const result = makeExactPriceConflictRuntime().classify(request, diagnostic);
    const conflict = Match.value(result.lookup).pipe(
      Match.tag('CONFLICT', (value) => value),
      Match.orElse(() => {
        throw new Error('Expected a redacted exact Price conflict');
      }),
    );

    expect(result.ownerDiagnostic?.claimants).toEqual(diagnostic.claimants);
    expect(result.ownerDiagnostic?.verification).toBe('OWNER_VERIFIED_COMPLETE_CURRENT_SET');
    expect(conflict.currentTruthRefs).toEqual([
      { priceRef: firstClaimant.priceRef, revisionId: firstClaimant.priceRevision.revisionId },
      { priceRef: secondClaimant.priceRef, revisionId: secondClaimant.priceRevision.revisionId },
    ]);
    expect(conflict.evidence).toEqual(evidence);
    expect(conflict.reason).toBe('COMPETING_CURRENT_EXACT_PRICES');
    expect(conflict.request).toEqual(request);
    expect(result.lookup).not.toHaveProperty('claimants');
    expect(JSON.stringify(result.lookup)).not.toContain('monetaryAmount');
    expect(JSON.stringify(result.lookup)).not.toContain('provenanceRefs');
  });

  it('does not fabricate a conflict when owner evidence is bound to another exact request', () => {
    const mismatchedRequest: ExactPriceLookupRequest = Schema.decodeSync(ExactPriceLookupRequestSchema)({
      ...request,
      exactKey: { ...exactKey, currencyCode: 'EUR' },
    });
    const result = makeExactPriceConflictRuntime().classify(mismatchedRequest, diagnostic);
    const unverifiable = Match.value(result.lookup).pipe(
      Match.tag('UNVERIFIABLE', (value) => value),
      Match.orElse(() => {
        throw new Error('Expected unverifiable owner conflict evidence');
      }),
    );

    expect(result.ownerDiagnostic).toBeUndefined();
    expect(unverifiable.reason).toBe('EXACT_KEY_BINDING_UNVERIFIABLE');
    expect(unverifiable.request).toEqual(mismatchedRequest);
  });

  it('passes owner-verified non-conflict outcomes through without inventing diagnostics', () => {
    const absent: ExactPriceOwnerLookupResult = { _tag: 'ABSENT', evidence, request };
    const result = makeExactPriceConflictRuntime().classify(request, absent);
    const decodedAbsent = Match.value(result.lookup).pipe(
      Match.tag('ABSENT', (value) => value),
      Match.orElse(() => {
        throw new Error('Expected owner-proven exact Price absence');
      }),
    );

    expect(decodedAbsent.evidence).toEqual(evidence);
    expect(decodedAbsent.request).toEqual(request);
    expect(result.ownerDiagnostic).toBeUndefined();
  });

  it('preserves a validated redacted conflict without fabricating private claimant evidence', () => {
    const runtime = makeExactPriceConflictRuntime();
    const publicConflict = runtime.classify(request, diagnostic).lookup;
    const result = runtime.classify(request, publicConflict);
    const conflict = Match.value(result.lookup).pipe(
      Match.tag('CONFLICT', (value) => value),
      Match.orElse(() => {
        throw new Error('Expected validated redacted exact Price conflict');
      }),
    );

    expect(conflict.currentTruthRefs).toHaveLength(2);
    expect(conflict.reason).toBe('COMPETING_CURRENT_EXACT_PRICES');
    expect(result.ownerDiagnostic).toBeUndefined();
  });
});
