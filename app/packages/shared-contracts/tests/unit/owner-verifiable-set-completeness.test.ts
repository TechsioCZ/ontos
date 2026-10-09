import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OwnerVerifiableSetCompletenessEvidenceSchema,
  OwnerVerifiableSetCompletenessScopeSchema,
} from '../../src/index.ts';
import type { OwnerVerifiableSetCompletenessEvidenceEncoded } from '../../src/index.ts';

// Evidence is a closed cross-owner envelope; receiving boundaries decode it with closed parse options.
const decodeEvidence = Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema, {
  onExcessProperty: 'error',
});
const encodeEvidence = Schema.encodeSync(OwnerVerifiableSetCompletenessEvidenceSchema);

const exactPredicateEvidence = {
  observedAt: '2026-09-21T10:15:30.000Z',
  ownerRevision: 'owner-revision:catalog/01K5Q9A7',
  scope: {
    kind: 'EXACT_PREDICATE',
    predicateRef: 'market-eligibility:tenant-a/seller-a/storefront-a/channel-web',
  },
} as const satisfies OwnerVerifiableSetCompletenessEvidenceEncoded;

it('round-trips exact-predicate completeness evidence through the public contract', () => {
  const decoded = decodeEvidence(exactPredicateEvidence);

  expect(encodeEvidence(decoded)).toEqual(exactPredicateEvidence);
  expect(OwnerVerifiableSetCompletenessEvidenceSchema).toBeDefined();
  expect(OwnerVerifiableSetCompletenessScopeSchema).toBeDefined();
});

it('round-trips safely-broader evidence with an optional next applicability boundary', () => {
  const safelyBroaderEvidence = {
    nextApplicabilityBoundary: '2026-09-22T00:00:00.000Z',
    observedAt: '2026-09-21T10:15:30.000Z',
    ownerRevision: 'opaque:policy-set@revision-seven',
    scope: {
      declaredScopeRef: 'currency-policy:tenant-a/all-current-selling-contexts',
      kind: 'SAFELY_BROADER_SCOPE',
      predicateRef: 'currency-policy:tenant-a/seller-a/market-cz/channel-web',
    },
  } as const;

  expect(encodeEvidence(decodeEvidence(safelyBroaderEvidence))).toEqual(safelyBroaderEvidence);
});

it('keeps owner revisions opaque instead of imposing numeric or provider grammar', () => {
  for (const ownerRevision of ['etag:"a7/opaque"', 'generation:catalog-blue', '01K5Q9A7ZXQW']) {
    expect(encodeEvidence(decodeEvidence({ ...exactPredicateEvidence, ownerRevision })).ownerRevision).toBe(
      ownerRevision,
    );
  }
});

it('rejects malformed, incomplete, and excess-property evidence shapes', () => {
  for (const invalid of [
    { ...exactPredicateEvidence, observedAt: 'not-an-instant' },
    { ...exactPredicateEvidence, ownerRevision: '' },
    { ...exactPredicateEvidence, ownerRevision: '   ' },
    { ...exactPredicateEvidence, scope: { kind: 'EXACT_PREDICATE', predicateRef: '' } },
    {
      ...exactPredicateEvidence,
      scope: {
        internalMatcherState: 'owner-private',
        kind: 'EXACT_PREDICATE',
        predicateRef: 'exact',
      },
    },
    { ...exactPredicateEvidence, scope: { kind: 'SAFELY_BROADER_SCOPE', predicateRef: 'exact' } },
    {
      ...exactPredicateEvidence,
      scope: {
        declaredScopeRef: '',
        kind: 'SAFELY_BROADER_SCOPE',
        predicateRef: 'exact',
      },
    },
    {
      ...exactPredicateEvidence,
      scope: {
        declaredScopeRef: 'broader',
        internalMatcherState: 'owner-private',
        kind: 'SAFELY_BROADER_SCOPE',
        predicateRef: 'exact',
      },
    },
    { ...exactPredicateEvidence, nextApplicabilityBoundary: 'not-an-instant' },
    { ...exactPredicateEvidence, internalOwnerCursor: 'private-state' },
  ]) {
    expect(() => decodeEvidence(invalid)).toThrow();
  }
});

it('rejects a non-future next applicability boundary', () => {
  for (const nextApplicabilityBoundary of [exactPredicateEvidence.observedAt, '2026-09-21T10:15:29.999Z']) {
    expect(() => decodeEvidence({ ...exactPredicateEvidence, nextApplicabilityBoundary })).toThrow();
  }
});

it('never accepts a winner or row count as standalone completeness evidence', () => {
  for (const pseudoEvidence of [
    { winnerRevision: 'rule-7' },
    { rowCount: 1 },
    { finalPage: true, rowCount: 0 },
    { observedAt: exactPredicateEvidence.observedAt, winnerRevision: 'rule-7' },
  ]) {
    expect(() => decodeEvidence(pseudoEvidence)).toThrow();
  }
});
