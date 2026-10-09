import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingFactCurrentnessEvidenceSchema,
  PricingOwnerQualifiedSetCompletenessEvidenceSchema,
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceMissingSchema,
  PricingSourceEvidenceTemporalContextSchema,
  PricingSourceEvidenceUnverifiableSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '../../src/domain/source-revision-evidence.ts';

const decodeResult = Schema.decodeUnknownSync(PricingSourceEvidenceResultSchema, {
  onExcessProperty: 'error',
});
const decodeTemporal = Schema.decodeUnknownSync(PricingSourceEvidenceTemporalContextSchema, {
  onExcessProperty: 'error',
});
const decodeFact = Schema.decodeUnknownSync(PricingFactCurrentnessEvidenceSchema, {
  onExcessProperty: 'error',
});
const decodeCompleteness = Schema.decodeUnknownSync(PricingOwnerQualifiedSetCompletenessEvidenceSchema, {
  onExcessProperty: 'error',
});

const ownerScope = {
  ownerModuleId: 'commerce.pricing',
  ownerRootRef: 'opaque:price-set/tenant-a',
  predicateRef: 'opaque:exact-price/variant-a/sle-a/channel-web/market-cz/eur/unit/no-group',
  tenantId: 'tenant-a',
} as const;

const temporal = {
  effectiveAt: '2026-09-28T09:55:00.000Z',
  evaluatedAt: '2026-09-28T10:00:01.000Z',
  evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
  nextMaterialBoundary: '2026-09-28T11:00:00.000Z',
  observedAt: '2026-09-28T10:00:02.000Z',
  requestedAt: '2026-09-28T10:00:00.000Z',
};

const verification = {
  kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
  verificationRef: 'opaque:price-proof/attempt-a',
};

const request = {
  currencyCode: 'EUR',
  effectiveAt: temporal.effectiveAt,
  family: 'PRICE' as const,
  ownerScope,
  requestedAt: temporal.requestedAt,
};

const completeness = {
  completenessEvidence: {
    nextApplicabilityBoundary: temporal.nextMaterialBoundary,
    observedAt: temporal.observedAt,
    ownerRevision: 'opaque:price-set/revision-17',
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: ownerScope.predicateRef,
    },
  },
  currencyCode: request.currencyCode,
  family: request.family,
  ownerScope,
  ownerSetRevisionRef: 'opaque:price-set/revision-17',
  temporal,
  verification,
};

const fact = {
  currencyCode: request.currencyCode,
  effectivePeriod: {
    effectiveFrom: '2026-09-28T09:00:00.000Z',
    effectiveTo: '2026-09-28T11:00:00.000Z',
  },
  factRef: 'opaque:price/price-a',
  factRevisionRef: 'opaque:price-revision/price-a-7',
  family: request.family,
  ownerScope,
  temporal,
  verification,
};

describe('Pricing source revision evidence contract', () => {
  it('keeps Fact Currentness and complete-set proof separate under ordinary request latency', () => {
    expect(
      Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(
        decodeResult({
          _tag: 'VERIFIED_PRESENT',
          completeness,
          currentFacts: [fact],
          request,
        }),
      ),
    ).toBe(true);
  });

  it('accepts a generalized ISO currency shape without declaring that currency supported at Launch', () => {
    expect(decodeFact(fact).currencyCode).toBe('EUR');
  });

  it('represents proven absence with completeness and no fabricated Current fact', () => {
    const supportOwnerScope = {
      ...ownerScope,
      ownerRootRef: 'opaque:currency-support/tenant-a',
      predicateRef: 'opaque:currency-support/tenant-a',
    };
    const supportRequest = {
      effectiveAt: temporal.effectiveAt,
      family: 'CURRENCY_SUPPORT' as const,
      ownerScope: supportOwnerScope,
      requestedAt: temporal.requestedAt,
    };
    const supportCompleteness = {
      completenessEvidence: {
        ...completeness.completenessEvidence,
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: supportOwnerScope.predicateRef },
      },
      family: supportRequest.family,
      ownerScope: supportOwnerScope,
      ownerSetRevisionRef: completeness.ownerSetRevisionRef,
      temporal: completeness.temporal,
      verification: completeness.verification,
    };

    expect(
      Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(
        decodeResult({
          _tag: 'VERIFIED_ABSENT',
          completeness: supportCompleteness,
          request: supportRequest,
        }),
      ),
    ).toBe(true);
  });

  it('requires distinct Current facts plus complete-set proof for a known conflict', () => {
    const secondFact = {
      ...fact,
      factRef: 'opaque:price/price-b',
      factRevisionRef: 'opaque:price-revision/price-b-2',
    };

    expect(
      Schema.is(PricingSourceEvidenceConflictSchema)(
        decodeResult({
          _tag: 'CONFLICT',
          completeness,
          currentFacts: [fact, secondFact],
          request,
        }),
      ),
    ).toBe(true);
    expect(() =>
      decodeResult({
        _tag: 'CONFLICT',
        completeness,
        currentFacts: [fact, fact],
        request,
      }),
    ).toThrow();
  });

  it('does not accept a winner Revision or opaque reference as set-completeness proof', () => {
    expect(() =>
      decodeResult({
        _tag: 'VERIFIED_PRESENT',
        currentFacts: [fact],
        request,
      }),
    ).toThrow();
    expect(() =>
      decodeCompleteness({
        currencyCode: request.currencyCode,
        family: request.family,
        ownerScope,
        ownerSetRevisionRef: 'opaque:price-set/revision-17',
        temporal,
        verification,
      }),
    ).toThrow();
  });

  it('rejects consumer-rewritten owner time, Revision, predicate, and material boundary', () => {
    expect(() =>
      decodeCompleteness({
        ...completeness,
        completenessEvidence: {
          ...completeness.completenessEvidence,
          observedAt: temporal.requestedAt,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCompleteness({
        ...completeness,
        completenessEvidence: {
          ...completeness.completenessEvidence,
          ownerRevision: 'opaque:price-set/revision-18',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCompleteness({
        ...completeness,
        completenessEvidence: {
          ...completeness.completenessEvidence,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'opaque:another-price-key' },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCompleteness({
        ...completeness,
        completenessEvidence: {
          ...completeness.completenessEvidence,
          nextApplicabilityBoundary: '2026-09-28T12:00:00.000Z',
        },
      }),
    ).toThrow();
  });

  it('distinguishes historical as-of evaluation from owner-current evaluation', () => {
    expect(
      decodeTemporal({
        ...temporal,
        evaluatedAt: temporal.effectiveAt,
        evaluationMode: 'HISTORICAL_AS_OF',
      }).evaluationMode,
    ).toBe('HISTORICAL_AS_OF');
    expect(() => decodeTemporal({ ...temporal, evaluationMode: 'HISTORICAL_AS_OF' })).toThrow();
    expect(() =>
      decodeTemporal({
        ...temporal,
        nextMaterialBoundary: temporal.observedAt,
      }),
    ).toThrow();
  });

  it('keeps missing initialization and unverifiable owner state as explicit non-success outcomes', () => {
    expect(
      Schema.is(PricingSourceEvidenceMissingSchema)(
        decodeResult({
          _tag: 'MISSING',
          observedAt: temporal.observedAt,
          reason: 'OWNER_ROOT_NOT_INITIALIZED',
          request,
          verification,
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingSourceEvidenceUnverifiableSchema)(
        decodeResult({
          _tag: 'UNVERIFIABLE',
          observedAt: temporal.observedAt,
          reason: 'SET_COMPLETENESS_UNVERIFIABLE',
          request,
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(() =>
      decodeResult({
        _tag: 'UNVERIFIABLE',
        completeness,
        observedAt: temporal.observedAt,
        reason: 'SET_COMPLETENESS_UNVERIFIABLE',
        request,
        retryable: true,
      }),
    ).toThrow();
  });
});
