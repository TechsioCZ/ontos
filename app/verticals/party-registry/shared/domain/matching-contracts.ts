import { DateTime, Option, Schema, SchemaGetter } from 'effect';

import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';
import { PartyMatchDecisionRefSchema } from '../resources/party-match-decision.ts';
import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';
import type { PartyCreateOutcomeSchema } from './identity-contracts.ts';
import { PartyCandidateSchema, PartyEvidenceEvaluationSchema } from './identity-contracts.ts';

export { ClaimOwnedByDifferentParty } from './claim-owned-by-different-party.ts';
export { DuplicateCandidateConflict } from './duplicate-candidate-conflict.ts';
export { PartyCreateRecoveryUnavailable } from './party-create-recovery-unavailable.ts';

const MatchOutcomeSchema = Schema.Literals(['MATCHED', 'NO_MATCH', 'AMBIGUOUS']);
type MatchOutcome = typeof MatchOutcomeSchema.Type;

export const RuleKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).pipe(
  Schema.brand('RuleKey'),
);

// Matching contracts predate Option/DateTime models and are consumed directly as JSON-shaped DTOs.
// Validate through Effect's temporal and absence codecs while retaining those decoded DTO shapes.
const UtcTimestampStringSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 && value.endsWith('Z') ? `${value.slice(0, -1)}.000Z` : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'timestamp must be a canonical UTC ISO instant';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  }),
);

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

export const PartyMatchRequestSchema = Schema.Struct({
  candidate: PartyCandidateSchema,
});
const MatchEvidenceExplanationSchema = Schema.Struct({
  evidenceRefs: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(Schema.isMaxLength(100)),
  ),
  identifierType: Schema.optionalKey(Schema.Literals(['ICO', 'CZ_DIC'])),
  namespace: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  normalizedValue: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  officialIdentifierRef: Schema.optionalKey(PartyOfficialIdentifierRefSchema),
  outcome: Schema.optionalKey(MatchOutcomeSchema),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ruleKey: RuleKeySchema,
  verification: Schema.optionalKey(Schema.Literals(['REJECTED', 'UNVERIFIED', 'VERIFIED'])),
});
const MatchPreviewEvidenceSchema = Schema.Struct({
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
  caseRef: Schema.toEncoded(Schema.OptionFromNullOr(DuplicateCandidateCaseRefSchema)),
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
  decisionRef: Schema.toEncoded(Schema.OptionFromNullOr(PartyMatchDecisionRefSchema)),
  lifecycleState: Schema.Literals(['NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED']),
  outcome: Schema.Literals([
    'MATCH_EXISTING',
    'CREATE_NEW',
    'NEEDS_EVIDENCE',
    'DISMISSED_AS_NON_SUBJECT',
    'CONFIRMED_DUPLICATE_PARTIES',
  ]),
  partyRef: Schema.toEncoded(Schema.OptionFromNullOr(PartyRefSchema)),
});
export type DuplicateCaseResolutionResult = typeof DuplicateCaseResolutionResultSchema.Type;

const PartyDecisionOperationSchema = Schema.Literals([
  'CREATE',
  'MATCH',
  'REVIEW_MATCH',
  'REVIEW_CREATE',
  'LIFECYCLE',
  'LEGACY',
]);
const CommittedCreateOutcomeSchema = Schema.Literals(['CREATED', 'MATCHED_EXISTING', 'AMBIGUOUS']);

const PartyMatchDecisionRecordFieldsSchema = Schema.Struct({
  caseRef: Schema.toEncoded(Schema.OptionFromNullOr(DuplicateCandidateCaseRefSchema)),
  committedCreateOutcome: Schema.toEncoded(
    Schema.OptionFromOptionalNullOr(CommittedCreateOutcomeSchema, {
      onNoneEncoding: null,
    }),
  ),
  decidedAt: UtcTimestampStringSchema,
  decisionRef: PartyMatchDecisionRefSchema,
  evidenceEvaluation: Schema.toEncoded(
    Schema.OptionFromOptionalNullOr(PartyEvidenceEvaluationSchema, {
      onNoneEncoding: null,
    }),
  ),
  evidenceExplanation: Schema.Array(MatchEvidenceExplanationSchema),
  matchRuleVersion: Schema.String,
  operation: Schema.optionalKey(PartyDecisionOperationSchema),
  outcome: Schema.Literals(['CREATED', 'MATCHED', 'NO_MATCH', 'AMBIGUOUS']),
  partyRef: Schema.toEncoded(Schema.OptionFromNullOr(PartyRefSchema)),
});
type DecisionRecord = typeof PartyMatchDecisionRecordFieldsSchema.Type;
const isCreateOperation = (operation: DecisionRecord['operation']): boolean =>
  operation === 'CREATE' || operation === 'REVIEW_CREATE';

const validateCreateOutcome = (record: DecisionRecord): string | undefined => {
  const isCreate = isCreateOperation(record.operation);
  const expected = record.outcome === 'MATCHED' ? 'MATCHED_EXISTING' : record.outcome;
  if (isCreate && (record.committedCreateOutcome !== expected || record.outcome === 'NO_MATCH')) {
    return 'Create decisions must preserve the exact committed Create result';
  }
  if (!isCreate && record.committedCreateOutcome !== null && record.committedCreateOutcome !== undefined) {
    return 'Only Create operations carry committed Create outcomes';
  }
  return undefined;
};

const validateDecisionReferences = (record: DecisionRecord): string | undefined => {
  if (record.outcome === 'AMBIGUOUS') {
    return record.partyRef === null && record.caseRef !== null
      ? undefined
      : 'Ambiguity requires exactly one case reference';
  }
  if (record.outcome === 'NO_MATCH') {
    return record.partyRef === null && record.caseRef === null ? undefined : 'NO_MATCH has no result reference';
  }
  return record.partyRef !== null && record.caseRef === null
    ? undefined
    : 'Resolved decisions require exactly one Party reference';
};

export const PartyMatchDecisionRecordSchema = PartyMatchDecisionRecordFieldsSchema.check(
  Schema.makeFilter((record) => validateCreateOutcome(record) ?? validateDecisionReferences(record)),
);
export const DuplicateCandidateDetailSchema = Schema.Struct({
  candidate: PartyCandidateSchema,
  candidateParties: Schema.Array(PartyRefSchema),
  caseRef: DuplicateCandidateCaseRefSchema,
  evaluatedEvidence: Schema.Array(MatchEvidenceExplanationSchema),
  lifecycleState: Schema.Literals(['OPEN', 'NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED']),
  matchRuleVersion: Schema.String,
  priorCaseRef: Schema.toEncoded(Schema.OptionFromNullOr(DuplicateCandidateCaseRefSchema)),
  resolutionOutcome: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  resolutionReason: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  resolvedAt: Schema.toEncoded(Schema.OptionFromNullOr(UtcTimestampStringSchema)),
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
});

const resolvedCreateResult = (record: DecisionRecord): typeof PartyCreateOutcomeSchema.Type | null => {
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

/** No inference from LEGACY, matching or lifecycle records is safe for Create recovery. */
export const committedCreateResult = (
  record: typeof PartyMatchDecisionRecordSchema.Type,
): typeof PartyCreateOutcomeSchema.Type | null => {
  if (!isCreateOperation(record.operation)) {
    return null;
  }
  if (
    record.committedCreateOutcome === 'AMBIGUOUS' &&
    record.caseRef !== null &&
    record.partyRef === null &&
    record.outcome === 'AMBIGUOUS'
  ) {
    return {
      caseRef: record.caseRef,
      decisionRef: record.decisionRef,
      outcome: 'AMBIGUOUS',
    };
  }
  return resolvedCreateResult(record);
};
