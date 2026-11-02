import { DateTime, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { PartyEvidenceEvaluationSchema } from '../../shared/domain/identity-contracts.ts';
import {
  classifyGuestPartyResolution,
  qualifyGuestIdentityDecision,
} from '../../src/services/guest-party-resolution.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000002';

const party = (partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED' = 'PERSON') => ({
  archived: false,
  partyId,
  partyType,
});

const base = {
  cases: [],
  partyIds: [partyId],
  identityProofs: [{ created: true, decisionId: 'accepted-owner-decision', partyId, subjectKey: 'same-subject' }],
  parties: [party()],
  tenantId,
} as const;

it('returns an existing owner only for a single active Party identity', () => {
  expect(classifyGuestPartyResolution(base)).toEqual({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  });
});

it('keeps unresolved Party ownership typed instead of asking CCC to infer it', () => {
  expect(classifyGuestPartyResolution({ ...base, parties: [party('UNRESOLVED')] })).toEqual({
    outcome: 'UNRESOLVED_PARTY_CREATED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  });
});

it('returns a scoped review case when owner evidence is still ambiguous', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      cases: [
        {
          caseId: '30000000-0000-4000-8000-000000000003',
          lifecycleState: 'OPEN',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
      ],
    }),
  ).toEqual({
    caseRef: {
      moduleId: 'party.registry',
      resourceId: '30000000-0000-4000-8000-000000000003',
      resourceType: 'party.registry.duplicate-candidate-case',
      tenantId,
    },
    outcome: 'AMBIGUOUS_MATCH',
  });
});

it('fails closed when accepted evidence points at competing or unavailable owners', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      partyIds: [partyId, '40000000-0000-4000-8000-000000000004'],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
  expect(
    classifyGuestPartyResolution({
      ...base,
      parties: [],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
  expect(
    classifyGuestPartyResolution({
      ...base,
      cases: [
        {
          caseId: '30000000-0000-4000-8000-000000000003',
          lifecycleState: 'OPEN',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
        {
          caseId: '50000000-0000-4000-8000-000000000005',
          lifecycleState: 'NEEDS_EVIDENCE',
          resolutionOutcome: null,
          selectedPartyId: null,
        },
      ],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
});

it('does not resolve archived or identity-free evidence into a Party owner', () => {
  expect(
    classifyGuestPartyResolution({
      ...base,
      parties: [{ ...party(), archived: true }],
    }),
  ).toEqual({
    outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
    reason: 'Guest evidence identifies an archived Party',
  });
  expect(
    classifyGuestPartyResolution({
      ...base,
      partyIds: [],
      parties: [],
    }),
  ).toEqual({
    outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE',
    reason: 'Guest evidence does not establish a Party identity',
  });
});

it('a lone contact candidate cannot establish an existing or unresolved Guest identity', () => {
  expect(classifyGuestPartyResolution({ ...base, identityProofs: [] }).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  expect(classifyGuestPartyResolution({ ...base, identityProofs: [], parties: [party('UNRESOLVED')] }).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
});

const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: '70000000-0000-4000-8000-000000000001',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const request = {
  correlationRoot: 'purchase-1241',
  guestEvidenceRef: 'guest-proof',
  legalEntityRef,
  requestedAt: DateTime.makeUnsafe('2026-10-19T12:00:00.000Z'),
};
const evaluation = Schema.decodeUnknownSync(PartyEvidenceEvaluationSchema)({
  evidence: [
    {
      basis: 'DIRECT_INTERACTION',
      evidenceRef: request.guestEvidenceRef,
      guestBinding: { correlationRoot: request.correlationRoot, legalEntityRef },
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'PERSON',
      statement: 'I attest this Guest purchase concerns this subject',
      subjectKey: 'same-subject',
    },
  ],
  reasonCode: 'proven_concrete_subject',
  subjectEligibilityVersion: 'party-concrete-subject.v1',
  subjectEligible: true,
  typeRuleVersion: 'party-subject-type.v1',
  typeSupported: true,
});
const decision = {
  actionInvocationId: 'accepted-owner-action',
  candidateFingerprint: 'a'.repeat(64),
  committedCreateOutcome: null,
  decidedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T11:00:00.000Z')),
  evidenceEvaluation: evaluation,
  matchDecisionId: 'accepted-owner-decision',
  matchRuleVersion: 'party-exact-claims.v1',
  operation: 'REVIEW_MATCH',
  outcome: 'MATCHED',
  partyId,
};
const review = {
  candidateFingerprint: decision.candidateFingerprint,
  candidateSnapshot: {
    names: [],
    partyType: 'PERSON' as const,
    provenance: { method: 'DIRECT_INTERACTION', source: 'authorized-reviewer' },
    subjectEvidence: evaluation.evidence,
    validFrom: '2026-10-19T10:00:00.000Z',
  },
  lifecycleState: 'RESOLVED',
  matchRuleVersion: decision.matchRuleVersion,
  resolutionActionInvocationId: decision.actionInvocationId,
  resolutionOutcome: 'MATCH_EXISTING',
  resolvedAt: decision.decidedAt,
  selectedPartyId: partyId,
};

it('qualifies only an exact committed reviewed Guest identity binding', () => {
  expect(qualifyGuestIdentityDecision(decision, [review], request)).toEqual({
    created: false,
    decisionId: decision.matchDecisionId,
    partyId,
    subjectKey: 'same-subject',
  });
  for (const invalidRequest of [
    { ...request, correlationRoot: 'another-purchase' },
    { ...request, guestEvidenceRef: 'another-evidence' },
    { ...request, legalEntityRef: { ...legalEntityRef, resourceId: '80000000-0000-4000-8000-000000000001' } },
    { ...request, legalEntityRef: { ...legalEntityRef, tenantId: '90000000-0000-4000-8000-000000000001' } },
    { ...request, requestedAt: DateTime.makeUnsafe('2026-10-19T10:59:59.999Z') },
  ]) {
    expect(qualifyGuestIdentityDecision(decision, [review], invalidRequest)).toBeUndefined();
  }
  // The independent subject key deliberately differs from the correlation: there is no invented equality rule.
  expect(evaluation.evidence[0]?.subjectKey).not.toBe(request.correlationRoot);
});

it('does not reinterpret legacy decisions, weak provenance or unknown rules as Guest proof', () => {
  for (const invalidDecision of [
    { ...decision, operation: 'LEGACY' },
    { ...decision, matchRuleVersion: 'unaccepted-rule' },
    { ...decision, evidenceEvaluation: null },
    { ...decision, evidenceEvaluation: { ...evaluation, subjectEligible: false } },
    { ...decision, evidenceEvaluation: { ...evaluation, typeSupported: false } },
    { ...decision, evidenceEvaluation: { ...evaluation, typeRuleVersion: 'unknown' } },
    {
      ...decision,
      evidenceEvaluation: {
        ...evaluation,
        evidence: evaluation.evidence.map(({ guestBinding: _binding, ...item }) => item),
      },
    },
    {
      ...decision,
      evidenceEvaluation: {
        ...evaluation,
        evidence: [{ ...evaluation.evidence[0], observedSubject: 'TECHNICAL_RECORD' }],
      },
    },
    { ...decision, committedCreateOutcome: 'MATCHED_EXISTING' },
  ]) {
    // SAFETY: invalid retained JSON is deliberately exercised at the persistence decoder boundary.
    expect(qualifyGuestIdentityDecision(invalidDecision as typeof decision, [review], request)).toBeUndefined();
  }
});

it('rejects a non-finite retained timestamp read and restores its instance-local seam', () => {
  const timestamp = DateTime.toDateUtc(request.requestedAt);
  const retainedDecision = { ...decision, decidedAt: timestamp };
  expect(qualifyGuestIdentityDecision(retainedDecision, [review], request)).toBeDefined();
  // The owner guard consumes getTime(); NaN is the same malformed-time signal as an invalid retained Date.
  const getTime = rs.spyOn(timestamp, 'getTime').mockReturnValue(Number.NaN);
  try {
    expect(qualifyGuestIdentityDecision(retainedDecision, [review], request)).toBeUndefined();
    expect(getTime).toHaveBeenCalledTimes(1);
  } finally {
    getTime.mockRestore();
  }
  expect(qualifyGuestIdentityDecision(retainedDecision, [review], request)).toBeDefined();
});

it('requires the exact resolved case, invocation, effective time and selected Party for reviewed proof', () => {
  expect(qualifyGuestIdentityDecision(decision, [], request)).toBeUndefined();
  for (const invalidReview of [
    { ...review, lifecycleState: 'OPEN' },
    { ...review, resolutionActionInvocationId: 'another-action' },
    { ...review, selectedPartyId: 'another-party' },
    { ...review, resolutionOutcome: 'CONFIRMED_DUPLICATE_PARTIES' },
    { ...review, candidateFingerprint: 'b'.repeat(64) },
    { ...review, resolvedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T12:00:00.001Z')) },
    { ...review, candidateSnapshot: { ...review.candidateSnapshot, validFrom: 'invalid' } },
    { ...review, candidateSnapshot: { ...review.candidateSnapshot, validFrom: '2026-10-19T12:00:00.001Z' } },
    { ...review, candidateSnapshot: { ...review.candidateSnapshot, subjectEvidence: [] } },
  ]) {
    expect(qualifyGuestIdentityDecision(decision, [invalidReview], request)).toBeUndefined();
  }
  expect(
    qualifyGuestIdentityDecision(
      decision,
      [{ ...review, resolvedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T12:00:00.000Z')) }],
      request,
    ),
  ).toBeDefined();
});

it('preserves authentic Create and exact-match precedents but never invents unresolved creation', () => {
  expect(
    qualifyGuestIdentityDecision(
      { ...decision, operation: 'CREATE', outcome: 'CREATED', committedCreateOutcome: 'CREATED' },
      [],
      request,
    )?.created,
  ).toBe(true);
  expect(qualifyGuestIdentityDecision({ ...decision, operation: 'MATCH' }, [], request)?.created).toBe(false);
  expect(
    classifyGuestPartyResolution({
      ...base,
      parties: [party('UNRESOLVED')],
      identityProofs: [{ ...base.identityProofs[0], created: false }],
    }).outcome,
  ).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
  expect(
    classifyGuestPartyResolution({
      ...base,
      identityProofs: [...base.identityProofs, { ...base.identityProofs[0], subjectKey: 'another-subject' }],
    }),
  ).toEqual({ outcome: 'PARTY_OWNER_INDETERMINATE', retryable: true });
});
