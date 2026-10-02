import {
  PricingFactCurrentnessEvidenceSchema,
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const tenantId = '20000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-28T10:00:00.000Z';
const requestedAt = '2026-09-28T10:00:00.100Z';
const evaluatedAt = '2026-09-28T10:00:00.400Z';
const observedAt = '2026-09-28T10:00:00.700Z';
const nextMaterialBoundary = '2026-09-28T11:00:00.000Z';

const decodeResult = Schema.decodeUnknownSync(PricingSourceEvidenceResultSchema, {
  onExcessProperty: 'error',
});
const decodeFact = Schema.decodeUnknownSync(PricingFactCurrentnessEvidenceSchema, {
  onExcessProperty: 'error',
});

const ownerScopeFor = (predicateRef: string, ownerModuleId = 'commerce.pricing') => ({
  ownerModuleId,
  ownerRootRef: `${ownerModuleId}:root:tenant-1`,
  predicateRef,
  tenantId,
});

const requestFor = (
  family:
    | 'PRICE'
    | 'QUANTITY_TIER'
    | 'DISCOUNT'
    | 'COMMERCIAL_FEE'
    | 'ZERO_FLOOR'
    | 'COMMERCIAL_CONTEXT'
    | 'CURRENCY_SUPPORT'
    | 'PROMOTION',
  predicateRef: string,
  currencyCode = 'CZK',
) => ({
  currencyCode,
  effectiveAt,
  family,
  ownerScope: ownerScopeFor(predicateRef),
  requestedAt,
});

const temporal = {
  effectiveAt,
  evaluatedAt,
  evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
  nextMaterialBoundary,
  observedAt,
  requestedAt,
};

const completenessFor = (request: ReturnType<typeof requestFor>, ownerSetRevisionRef = 'set-revision-7') => ({
  completenessEvidence: {
    nextApplicabilityBoundary: nextMaterialBoundary,
    observedAt,
    ownerRevision: ownerSetRevisionRef,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: request.ownerScope.predicateRef },
  },
  currencyCode: request.currencyCode,
  family: request.family,
  ownerScope: request.ownerScope,
  ownerSetRevisionRef,
  temporal,
  verification: {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: `proof:${ownerSetRevisionRef}`,
  },
});

const factFor = (
  request: ReturnType<typeof requestFor>,
  factRef = 'fact:price:group-vip',
  factRevisionRef = 'fact-revision:price:7',
) => ({
  currencyCode: request.currencyCode,
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  factRef,
  factRevisionRef,
  family: request.family,
  ownerScope: request.ownerScope,
  temporal,
  verification: {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: `proof:${factRevisionRef}`,
  },
});

describe('issue #786 source revision evidence acceptance', () => {
  it('keeps material fact currentness independent from owner-verifiable set completeness', () => {
    const request = requestFor('PRICE', 'price:variant-1:sle-1:B2C:market-cz:CZK:unit-each:group-vip');
    const currentFact = factFor(request);
    const result = decodeResult({
      _tag: 'VERIFIED_PRESENT',
      completeness: completenessFor(request),
      currentFacts: [currentFact],
      request,
    });

    expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(result)).toBe(true);
    if (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(result)) {
      throw new Error('Expected verified present evidence');
    }
    expect(result.currentFacts).toEqual([currentFact]);
    expect(result.completeness).not.toEqual(currentFact);
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_PRESENT',
        currentFacts: [currentFact],
        request,
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_ABSENT',
        request,
      }),
    ).toThrow();
  });

  it('proves exact Group absence separately from the no-group Price and changes path when G is inserted', () => {
    const groupRequest = requestFor('PRICE', 'price:variant-1:sle-1:B2C:market-cz:CZK:unit-each:group-vip');
    const noGroupRequest = requestFor('PRICE', 'price:variant-1:sle-1:B2C:market-cz:CZK:unit-each:no-group');
    const groupAbsent = decodeResult({
      _tag: 'VERIFIED_ABSENT',
      completeness: completenessFor(groupRequest, 'group-price-set:6'),
      request: groupRequest,
    });
    const noGroupPresent = decodeResult({
      _tag: 'VERIFIED_PRESENT',
      completeness: completenessFor(noGroupRequest, 'no-group-price-set:4'),
      currentFacts: [factFor(noGroupRequest, 'price:no-group', 'price:no-group:revision-4')],
      request: noGroupRequest,
    });
    const groupInserted = decodeResult({
      _tag: 'VERIFIED_PRESENT',
      completeness: completenessFor(groupRequest, 'group-price-set:7'),
      currentFacts: [factFor(groupRequest, 'price:group-vip', 'price:group-vip:revision-1')],
      request: groupRequest,
    });

    expect(Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(groupAbsent)).toBe(true);
    expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(noGroupPresent)).toBe(true);
    expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(groupInserted)).toBe(true);
    expect(groupInserted.request.ownerScope.predicateRef).not.toBe(noGroupPresent.request.ownerScope.predicateRef);
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_ABSENT',
        completeness: completenessFor(noGroupRequest),
        request: groupRequest,
      }),
    ).toThrow();
  });

  it('retains exact Tier, Discount, Fee, floor, context, currency, and Promotion proof families', () => {
    const families = [
      'QUANTITY_TIER',
      'DISCOUNT',
      'COMMERCIAL_FEE',
      'ZERO_FLOOR',
      'COMMERCIAL_CONTEXT',
      'CURRENCY_SUPPORT',
      'PROMOTION',
    ] as const;

    for (const family of families) {
      const request = requestFor(family, `${family}:candidate-1:tenant-1:CZK`);
      const result = decodeResult({
        _tag: 'VERIFIED_PRESENT',
        completeness: completenessFor(request),
        currentFacts: [factFor(request, `${family}:fact`, `${family}:revision-1`)],
        request,
      });
      expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(result)).toBe(true);
      expect(result.request.family).toBe(family);
    }
  });

  it('accepts real nonzero latency without false staleness and rejects future or expired proof timing', () => {
    const request = requestFor('PRICE', 'price:latency-proof');
    const latencyResult = decodeResult({
      _tag: 'VERIFIED_PRESENT',
      completeness: completenessFor(request),
      currentFacts: [factFor(request)],
      request,
    });
    expect(Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(latencyResult)).toBe(true);
    expect(latencyResult).toMatchObject({
      currentFacts: [{ temporal: { effectiveAt, evaluatedAt, observedAt, requestedAt } }],
    });

    expect(() =>
      decodeFact({
        ...factFor(request),
        temporal: { ...temporal, evaluatedAt: '2026-09-28T10:00:01.000Z' },
      }),
    ).toThrow();
    expect(() =>
      decodeFact({
        ...factFor(request),
        effectivePeriod: {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveTo: evaluatedAt,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeFact({
        ...factFor(request),
        temporal: { ...temporal, nextMaterialBoundary: observedAt },
      }),
    ).toThrow();
  });

  it('keeps missing, conflict, owner outage, and unverifiable proof distinct', () => {
    const request = requestFor('DISCOUNT', 'discount:line-1:counterparty:1');
    const conflict = decodeResult({
      _tag: 'CONFLICT',
      completeness: completenessFor(request),
      currentFacts: [
        factFor(request, 'discount:logical-1', 'discount:revision-1'),
        factFor(request, 'discount:logical-1', 'discount:revision-2'),
      ],
      request,
    });
    const missing = decodeResult({
      _tag: 'MISSING',
      observedAt,
      reason: 'REQUIRED_CONFIGURATION_MISSING',
      request,
      verification: {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE',
        verificationRef: 'discount:missing-proof',
      },
    });
    const outage = decodeResult({
      _tag: 'UNVERIFIABLE',
      observedAt,
      reason: 'OWNER_UNAVAILABLE',
      request,
      retryable: true,
    });
    const unverifiable = decodeResult({
      _tag: 'UNVERIFIABLE',
      observedAt,
      reason: 'SET_COMPLETENESS_UNVERIFIABLE',
      request,
      retryable: false,
    });

    expect(Schema.is(PricingSourceEvidenceConflictSchema)(conflict)).toBe(true);
    expect(Schema.is(PricingSourceEvidenceMissingSchema)(missing)).toBe(true);
    expect(Schema.is(PricingSourceEvidenceUnverifiableSchema)(outage)).toBe(true);
    expect(Schema.is(PricingSourceEvidenceUnverifiableSchema)(unverifiable)).toBe(true);
    if (
      !Schema.is(PricingSourceEvidenceUnverifiableSchema)(outage) ||
      !Schema.is(PricingSourceEvidenceUnverifiableSchema)(unverifiable)
    ) {
      throw new Error('Expected typed unverifiable outcomes');
    }
    expect(outage.reason).not.toBe(unverifiable.reason);
  });

  it('does not accept a Revision, hash, row count, or import marker as owner proof', () => {
    const request = requestFor('PRICE', 'price:exact-key');
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_PRESENT',
        currentFacts: [
          {
            factRevisionRef: 'price:revision-1',
            hash: 'looks-stable',
            rowCount: 1,
          },
        ],
        importSuccess: true,
        pricingRevision: 'pricing:17',
        request,
      }),
    ).toThrow();
  });

  it('binds exact owner, predicate, Tenant, candidate context, and currency without activating FX', () => {
    const czkRequest = requestFor('PRICE', 'price:candidate-1:sle-1:B2C:market-cz:CZK', 'CZK');
    const eurRequest = requestFor('PRICE', 'price:candidate-1:sle-1:B2C:market-cz:EUR', 'EUR');
    const czkFact = factFor(czkRequest);

    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_PRESENT',
        completeness: completenessFor(eurRequest),
        currentFacts: [czkFact],
        request: czkRequest,
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_PRESENT',
        completeness: completenessFor(czkRequest),
        currentFacts: [{ ...czkFact, fxRate: '25.00' }],
        request: czkRequest,
      }),
    ).toThrow();

    const generalizedEurProof = decodeResult({
      _tag: 'VERIFIED_PRESENT',
      completeness: completenessFor(eurRequest),
      currentFacts: [factFor(eurRequest, 'price:eur', 'price:eur:revision-1')],
      request: eurRequest,
    });
    expect(generalizedEurProof).toMatchObject({
      currentFacts: [{ currencyCode: 'EUR' }],
      request: { currencyCode: 'EUR' },
    });
  });
});
