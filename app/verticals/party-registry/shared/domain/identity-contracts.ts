/* eslint-disable max-classes-per-file -- The generated identity contract keeps its closed tagged-error family together. */
import { DateTime, Option, Schema } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';
import type { PartyRef } from '../resources/party.ts';
import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';
import { PartyMatchDecisionRefSchema } from '../resources/party-match-decision.ts';
import { OfficialIdentifierInputSchema } from './identifier-contracts.ts';
import { AresAppliedEvidenceSchema } from './ares-application.ts';

export const PartyTypeSchema = Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']);
export type PartyType = typeof PartyTypeSchema.Type;
export const isPartyTypeEnrichment = (current: PartyType, requested: PartyType): boolean =>
  current === requested || (current === 'UNRESOLVED' && requested !== 'UNRESOLVED');
export const IsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'invalid UTC calendar timestamp';
  }),
);
export const PartyDisplayNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
);
export const ProvenanceSchema = Schema.Struct({
  externalEvidence: Schema.optionalKey(AresAppliedEvidenceSchema),
  method: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  source: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

/** Evidence is an explicit attestation accepted by the authenticated owner Action. References
 * locate supporting material; their spelling and a claimed provider label confer no authority.
 * Provider-only and managed Legal Entity inputs are not supported attestation sources. */
export const PartySubjectEvidenceSchema = Schema.Struct({
  basis: Schema.Literals(['DIRECT_INTERACTION', 'REVIEWED_DOCUMENT']),
  evidenceRef: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  kind: Schema.Literal('ACTOR_ATTESTATION'),
  observedSubject: Schema.Literals([
    'PERSON',
    'ORGANIZATION',
    'CONCRETE_SUBJECT',
    'TECHNICAL_RECORD',
    'MANAGED_LEGAL_ENTITY',
  ]),
  statement: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  subjectKey: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type PartySubjectEvidence = typeof PartySubjectEvidenceSchema.Type;
export const PartySubjectEvidenceListSchema = Schema.Array(PartySubjectEvidenceSchema).check(
  Schema.isMaxLength(32),
);
export const PartySubjectEligibilityVersion = 'party-concrete-subject.v1' as const;
export const PartyTypeRuleVersion = 'party-subject-type.v1' as const;
export const PartyEvidenceEvaluationSchema = Schema.Struct({
  evidence: PartySubjectEvidenceListSchema,
  reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  subjectEligibilityVersion: Schema.String,
  subjectEligible: Schema.Boolean,
  typeRuleVersion: Schema.String,
  typeSupported: Schema.Boolean,
});
export type PartyEvidenceEvaluation = typeof PartyEvidenceEvaluationSchema.Type;

export const PartyCandidateSchema = Schema.Struct({
  displayName: Schema.optionalKey(PartyDisplayNameSchema),
  evidenceRefs: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ).check(Schema.isMaxLength(100)),
  officialIdentifiers: Schema.Array(OfficialIdentifierInputSchema).check(Schema.isMaxLength(20)),
  partyType: PartyTypeSchema,
  provenance: ProvenanceSchema,
  subjectEvidence: Schema.optionalKey(PartySubjectEvidenceListSchema),
  validFrom: IsoTimestampSchema,
});
export type PartyCandidate = typeof PartyCandidateSchema.Type;

export const PartySchema = Schema.Struct({
  archivedAt: Schema.NullOr(IsoTimestampSchema),
  createdAt: IsoTimestampSchema,
  displayName: Schema.NullOr(PartyDisplayNameSchema),
  partyRef: PartyRefSchema,
  partyType: PartyTypeSchema,
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  updatedAt: IsoTimestampSchema,
});
export type Party = typeof PartySchema.Type;

export const makePartyRef = (tenantId: string, partyId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
});

export const PartyCreateOutcomeSchema = Schema.Union([
  Schema.Struct({
    decisionRef: PartyMatchDecisionRefSchema,
    outcome: Schema.Literal('CREATED'),
    partyRef: PartyRefSchema,
  }),
  Schema.Struct({
    decisionRef: PartyMatchDecisionRefSchema,
    outcome: Schema.Literal('MATCHED_EXISTING'),
    partyRef: PartyRefSchema,
  }),
  Schema.Struct({
    caseRef: DuplicateCandidateCaseRefSchema,
    decisionRef: PartyMatchDecisionRefSchema,
    outcome: Schema.Literal('AMBIGUOUS'),
  }),
]);
export type PartyCreateOutcome = typeof PartyCreateOutcomeSchema.Type;

export class PartyNotFound extends Schema.TaggedError<PartyNotFound>()('PartyNotFound', {
  code: Schema.Literal('party_not_found'),
  partyId: Schema.String.check(Schema.isUUID()),
  reason: Schema.String,
}) {}
export class PartyLifecycleConflict extends Schema.TaggedError<PartyLifecycleConflict>()(
  'PartyLifecycleConflict',
  {
    code: Schema.Literal('party_lifecycle_conflict'),
    reason: Schema.String,
    requestedState: Schema.Literals(['ACTIVE', 'ARCHIVED']),
  },
) {}
export class PartyUnarchiveIdentityConflict extends Schema.TaggedError<PartyUnarchiveIdentityConflict>()(
  'PartyUnarchiveIdentityConflict',
  {
    code: Schema.Literal('party_unarchive_identity_conflict'),
    conflictingPartyRef: PartyRefSchema,
    reason: Schema.String,
  },
) {}
export class PartyUnarchiveIdentityAmbiguous extends Schema.TaggedError<PartyUnarchiveIdentityAmbiguous>()(
  'PartyUnarchiveIdentityAmbiguous',
  {
    candidatePartyRefs: Schema.Array(PartyRefSchema).check(Schema.isMinLength(2)),
    code: Schema.Literal('party_unarchive_identity_ambiguous'),
    reason: Schema.String,
  },
) {}
export class PartyUnarchiveReviewRequired extends Schema.TaggedError<PartyUnarchiveReviewRequired>()(
  'PartyUnarchiveReviewRequired',
  {
    caseRefs: Schema.Array(DuplicateCandidateCaseRefSchema),
    code: Schema.Literal('party_unarchive_review_required'),
    reason: Schema.String,
    reasonCode: Schema.Literals(['OPEN_DUPLICATE_CASE', 'UNRESOLVED_IDENTITY']),
  },
) {}
export class PartyEvidenceInsufficient extends Schema.TaggedError<PartyEvidenceInsufficient>()(
  'PartyEvidenceInsufficient',
  {
    code: Schema.Literal('party_evidence_insufficient'),
    reason: Schema.String,
  },
) {}
export class PartyPersistenceUnavailable extends Schema.TaggedError<PartyPersistenceUnavailable>()(
  'PartyPersistenceUnavailable',
  {
    code: Schema.Literal('party_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
