import { Brand, Schema } from 'effect';

import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';
import { PartyMatchDecisionRefSchema } from '../resources/party-match-decision.ts';
import { PartyRefSchema } from '../resources/party.ts';
import type { PartyRef } from '../resources/party.ts';
import { AresAppliedEvidenceSchema } from './ares-application.ts';
import { OfficialIdentifierInputSchema } from './identifier-contracts.ts';

export const PartyTypeSchema = Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']);
export type PartyType = typeof PartyTypeSchema.Type;
export const isPartyTypeEnrichment = (current: PartyType, requested: PartyType): boolean =>
  current === requested || (current === 'UNRESOLVED' && requested !== 'UNRESOLVED');
export const IsoTimestampSchema = Schema.DateTimeUtcFromString;
export const PartyIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PartyId'));
export type PartyId = typeof PartyIdSchema.Type;
const PartySubjectKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('PartySubjectKey'),
);
export type PartySubjectKey = typeof PartySubjectKeySchema.Type;
export const partyIdFromString = Brand.nominal<PartyId>();
export const partySubjectKeyFromString = Brand.nominal<PartySubjectKey>();
export const PartyDisplayNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ProvenanceSchema = Schema.Struct({
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
  subjectKey: PartySubjectKeySchema,
});
export type PartySubjectEvidence = typeof PartySubjectEvidenceSchema.Type;
export const PartySubjectEvidenceListSchema = Schema.Array(PartySubjectEvidenceSchema).check(Schema.isMaxLength(32));
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
  evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
    Schema.isMaxLength(100),
  ),
  officialIdentifiers: Schema.Array(OfficialIdentifierInputSchema).check(Schema.isMaxLength(20)),
  partyType: PartyTypeSchema,
  provenance: ProvenanceSchema,
  subjectEvidence: Schema.optionalKey(PartySubjectEvidenceListSchema),
  validFrom: IsoTimestampSchema,
});
export type PartyCandidate = typeof PartyCandidateSchema.Type;

export const PartySchema = Schema.Struct({
  archivedAt: Schema.OptionFromNullOr(IsoTimestampSchema),
  createdAt: IsoTimestampSchema,
  displayName: Schema.OptionFromNullOr(PartyDisplayNameSchema),
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

const partyNotFoundFields = {
  code: Schema.Literal('party_not_found'),
  partyId: PartyIdSchema,
  reason: Schema.String,
} as const;
const PartyNotFoundSchema = Schema.TaggedStruct('PartyNotFound', partyNotFoundFields);
export const PartyNotFound = Schema.TaggedError<typeof PartyNotFoundSchema.Type>()(
  'PartyNotFound',
  partyNotFoundFields,
);
export type PartyNotFoundError = InstanceType<typeof PartyNotFound>;

const partyLifecycleConflictFields = {
  code: Schema.Literal('party_lifecycle_conflict'),
  reason: Schema.String,
  requestedState: Schema.Literals(['ACTIVE', 'ARCHIVED']),
} as const;
const PartyLifecycleConflictSchema = Schema.TaggedStruct('PartyLifecycleConflict', partyLifecycleConflictFields);
export const PartyLifecycleConflict = Schema.TaggedError<typeof PartyLifecycleConflictSchema.Type>()(
  'PartyLifecycleConflict',
  partyLifecycleConflictFields,
);

const partyEvidenceInsufficientFields = {
  code: Schema.Literal('party_evidence_insufficient'),
  reason: Schema.String,
} as const;
const PartyEvidenceInsufficientSchema = Schema.TaggedStruct(
  'PartyEvidenceInsufficient',
  partyEvidenceInsufficientFields,
);
export const PartyEvidenceInsufficient = Schema.TaggedError<typeof PartyEvidenceInsufficientSchema.Type>()(
  'PartyEvidenceInsufficient',
  partyEvidenceInsufficientFields,
);
export type PartyEvidenceInsufficientError = InstanceType<typeof PartyEvidenceInsufficient>;

const partyPersistenceUnavailableFields = {
  code: Schema.Literal('party_persistence_unavailable'),
  reason: Schema.String,
} as const;
const PartyPersistenceUnavailableSchema = Schema.TaggedStruct(
  'PartyPersistenceUnavailable',
  partyPersistenceUnavailableFields,
);
export const PartyPersistenceUnavailable = Schema.TaggedError<typeof PartyPersistenceUnavailableSchema.Type>()(
  'PartyPersistenceUnavailable',
  partyPersistenceUnavailableFields,
);
export type PartyPersistenceUnavailableError = InstanceType<typeof PartyPersistenceUnavailable>;
