/* eslint-disable max-classes-per-file -- Matching exposes one closed typed domain-failure vocabulary. */
import { Schema } from 'effect';
import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';
import { PartyMatchDecisionRefSchema } from '../resources/party-match-decision.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import type { PartyCreateOutcomeSchema } from './identity-contracts.ts';
import { PartyCandidateSchema, PartyEvidenceEvaluationSchema } from './identity-contracts.ts';

export const MatchOutcomeSchema = Schema.Literals(['MATCHED', 'NO_MATCH', 'AMBIGUOUS']);
export type MatchOutcome = typeof MatchOutcomeSchema.Type;

export const sortClaimKeys = (keys: readonly string[]): readonly string[] =>
  [...new Set(keys)].toSorted((left, right) => left.localeCompare(right, 'en'));

export const evaluateExactClaims = (partyIds: readonly string[]) => {
  const resolved = [...new Set(partyIds)].toSorted();
  let outcome: MatchOutcome = 'AMBIGUOUS';
  if (resolved.length === 0) {
    outcome = 'NO_MATCH';
  } else if (resolved.length === 1) {
    outcome = 'MATCHED';
  }
  return {
    outcome,
    partyIds: resolved,
  } as const;
};

export const PartyMatchRequestSchema = Schema.Struct({ candidate: PartyCandidateSchema });
export const MatchEvidenceExplanationSchema = Schema.Struct({
  evidenceRefs: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
      Schema.isMaxLength(100),
    ),
  ),
  identifierType: Schema.optionalKey(Schema.Literals(['ICO', 'CZ_DIC'])),
  namespace: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  normalizedValue: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  officialIdentifierRef: Schema.optionalKey(PartyOfficialIdentifierRefSchema),
  outcome: Schema.optionalKey(MatchOutcomeSchema),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ruleKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  verification: Schema.optionalKey(Schema.Literals(['REJECTED', 'UNVERIFIED', 'VERIFIED'])),
});
export const MatchPreviewEvidenceSchema = Schema.Struct({
  kind: Schema.Literals(['EXACT_CLAIM', 'WEAK_EVIDENCE']),
  partyRef: PartyRefSchema,
});
export const PartyMatchPreviewResponseSchema = Schema.Struct({
  candidateParties: Schema.Array(PartyRefSchema),
  evidenceExplanation: Schema.Array(MatchPreviewEvidenceSchema),
  matchRuleVersion: Schema.String,
  outcome: MatchOutcomeSchema,
});
export const PartyMatchResponseSchema = Schema.Struct({
  candidateParties: Schema.Array(PartyRefSchema),
  caseRef: Schema.NullOr(DuplicateCandidateCaseRefSchema),
  decisionRef: PartyMatchDecisionRefSchema,
  evidenceExplanation: Schema.Array(MatchEvidenceExplanationSchema),
  matchRuleVersion: Schema.String,
  outcome: MatchOutcomeSchema,
});

export const DuplicateCaseResolutionPayloadSchema = Schema.Struct({
  caseRef: DuplicateCandidateCaseRefSchema,
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});

export const DuplicateCaseResolutionResultSchema = Schema.Struct({
  caseRef: DuplicateCandidateCaseRefSchema,
  decisionRef: Schema.NullOr(PartyMatchDecisionRefSchema),
  lifecycleState: Schema.Literals(['NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED']),
  outcome: Schema.Literals([
    'MATCH_EXISTING',
    'CREATE_NEW',
    'NEEDS_EVIDENCE',
    'DISMISSED_AS_NON_SUBJECT',
    'CONFIRMED_DUPLICATE_PARTIES',
  ]),
  partyRef: Schema.NullOr(PartyRefSchema),
});
export type DuplicateCaseResolutionResult = typeof DuplicateCaseResolutionResultSchema.Type;

export class DuplicateCandidateConflict extends Schema.TaggedError<DuplicateCandidateConflict>()(
  'DuplicateCandidateConflict',
  {
    code: Schema.Literal('duplicate_candidate_conflict'),
    reason: Schema.String,
  },
) {}
export class ClaimOwnedByDifferentParty extends Schema.TaggedError<ClaimOwnedByDifferentParty>()(
  'ClaimOwnedByDifferentParty',
  {
    code: Schema.Literal('claim_owned_by_different_party'),
    reason: Schema.String,
  },
) {}

export const PartyDecisionOperationSchema = Schema.Literals([
  'CREATE',
  'MATCH',
  'REVIEW_MATCH',
  'REVIEW_CREATE',
  'LIFECYCLE',
  'LEGACY',
]);
export const CommittedCreateOutcomeSchema = Schema.Literals([
  'CREATED',
  'MATCHED_EXISTING',
  'AMBIGUOUS',
]);

export const PartyMatchDecisionRecordSchema = Schema.Struct({
  caseRef: Schema.NullOr(DuplicateCandidateCaseRefSchema),
  committedCreateOutcome: Schema.optionalKey(Schema.NullOr(CommittedCreateOutcomeSchema)),
  decidedAt: Schema.String,
  decisionRef: PartyMatchDecisionRefSchema,
  evidenceEvaluation: Schema.optionalKey(Schema.NullOr(PartyEvidenceEvaluationSchema)),
  evidenceExplanation: Schema.Array(MatchEvidenceExplanationSchema),
  matchRuleVersion: Schema.String,
  operation: Schema.optionalKey(PartyDecisionOperationSchema),
  outcome: Schema.Literals(['CREATED', 'MATCHED', 'NO_MATCH', 'AMBIGUOUS']),
  partyRef: Schema.NullOr(PartyRefSchema),
}).check(
  Schema.makeFilter((record) => {
    const isCreate = record.operation === 'CREATE' || record.operation === 'REVIEW_CREATE';
    const expected = record.outcome === 'MATCHED' ? 'MATCHED_EXISTING' : record.outcome;
    if (isCreate && (record.committedCreateOutcome !== expected || record.outcome === 'NO_MATCH')) {
      return 'Create decisions must preserve the exact committed Create result';
    }
    if (
      !isCreate &&
      record.committedCreateOutcome !== null &&
      record.committedCreateOutcome !== undefined
    ) {
      return 'Only Create operations carry committed Create outcomes';
    }
    if (record.outcome === 'AMBIGUOUS') {
      return record.partyRef === null && record.caseRef !== null
        ? undefined
        : 'Ambiguity requires exactly one case reference';
    }
    if (record.outcome === 'NO_MATCH') {
      return record.partyRef === null && record.caseRef === null
        ? undefined
        : 'NO_MATCH has no result reference';
    }
    return record.partyRef !== null && record.caseRef === null
      ? undefined
      : 'Resolved decisions require exactly one Party reference';
  }),
);
export const DuplicateCandidateDetailSchema = Schema.Struct({
  candidate: PartyCandidateSchema,
  candidateParties: Schema.Array(PartyRefSchema),
  caseRef: DuplicateCandidateCaseRefSchema,
  evaluatedEvidence: Schema.Array(MatchEvidenceExplanationSchema),
  lifecycleState: Schema.Literals(['OPEN', 'NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED']),
  matchRuleVersion: Schema.String,
  priorCaseRef: Schema.NullOr(DuplicateCandidateCaseRefSchema),
  resolutionOutcome: Schema.NullOr(Schema.String),
  resolutionReason: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
});

/** No inference from LEGACY, matching or lifecycle records is safe for Create recovery. */
export const committedCreateResult = (
  record: typeof PartyMatchDecisionRecordSchema.Type,
): typeof PartyCreateOutcomeSchema.Type | null => {
  if (record.operation !== 'CREATE' && record.operation !== 'REVIEW_CREATE') {
    return null;
  }
  if (
    record.committedCreateOutcome === 'AMBIGUOUS' &&
    record.caseRef !== null &&
    record.partyRef === null &&
    record.outcome === 'AMBIGUOUS'
  ) {
    return { caseRef: record.caseRef, decisionRef: record.decisionRef, outcome: 'AMBIGUOUS' };
  }
  if (
    record.partyRef !== null &&
    record.caseRef === null &&
    ((record.committedCreateOutcome === 'CREATED' && record.outcome === 'CREATED') ||
      (record.committedCreateOutcome === 'MATCHED_EXISTING' && record.outcome === 'MATCHED'))
  ) {
    return {
      decisionRef: record.decisionRef,
      outcome: record.committedCreateOutcome,
      partyRef: record.partyRef,
    };
  }
  return null;
};
export class PartyCreateRecoveryUnavailable extends Schema.TaggedError<PartyCreateRecoveryUnavailable>()(
  'PartyCreateRecoveryUnavailable',
  {
    reason: Schema.String,
  },
) {}
