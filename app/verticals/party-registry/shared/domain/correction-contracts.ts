import { Schema } from 'effect';
import { PartySubjectEvidenceListSchema } from './identity-contracts.ts';
import {
  PartyRelationshipProvenanceSchema,
  RelationshipEndEvidenceSchema,
  RelationshipIsoTimestampSchema,
} from './relationship-contract.ts';
import { PartyCorrectionRefSchema } from '../resources/party-correction.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { PartyRelationshipRefSchema } from '../resources/party-relationship.ts';

export const CorrectablePartyFactSchema = Schema.Literals([
  'PARTY_TYPE',
  'DISPLAY_NAME',
  'OFFICIAL_IDENTIFIER',
  'RELATIONSHIP',
]);
export type CorrectablePartyFact = typeof CorrectablePartyFactSchema.Type;

const EvidenceRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
).check(Schema.isMinLength(1), Schema.isMaxLength(32));
export const PartyCorrectionPolicyVersion = 'party-correction.v1' as const;
const PolicyVersionSchema = Schema.Literal(PartyCorrectionPolicyVersion);
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const PositiveRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);

export const PartyCorrectionReasonCodeSchema = Schema.Literals([
  'WRONG_PARTY_TYPE',
  'WRONG_PARTY_ASSIGNMENT',
  'WRONG_IDENTITY_VALUE',
]);
export type PartyCorrectionReasonCode = typeof PartyCorrectionReasonCodeSchema.Type;

export const PartyCorrectionEvidenceSourceSchema = Schema.Literals([
  'AUTHORITATIVE_REGISTRY',
  'DOCUMENT',
  'MANUAL_REVIEW',
  'SYSTEM_RECONCILIATION',
]);
export type PartyCorrectionEvidenceSource = typeof PartyCorrectionEvidenceSourceSchema.Type;

const correctionEvidenceFields = {
  evidenceRefs: EvidenceRefsSchema,
  evidenceSource: PartyCorrectionEvidenceSourceSchema,
  policyVersion: PolicyVersionSchema,
  provenance: PartyRelationshipProvenanceSchema,
  reasonCode: PartyCorrectionReasonCodeSchema,
  reasonDetail: Schema.optionalKey(ReasonSchema),
} as const;

export const IdentityCorrectionCommandSchema = Schema.Struct({
  subjectEvidence: Schema.optionalKey(PartySubjectEvidenceListSchema),
  ...correctionEvidenceFields,
  factKind: Schema.Literals(['PARTY_TYPE', 'DISPLAY_NAME', 'OFFICIAL_IDENTIFIER']),
  partyId: Schema.String.check(Schema.isUUID()),
  replacementValue: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  ),
  targetAssertionId: Schema.String.check(Schema.isUUID()),
}).check(
  Schema.makeFilter((command) =>
    command.factKind !== 'OFFICIAL_IDENTIFIER' && command.replacementValue === undefined
      ? 'Party Type and display-name correction require a replacement assertion'
      : undefined,
  ),
);
export type IdentityCorrectionCommand = typeof IdentityCorrectionCommandSchema.Type;

export const RelationshipCorrectionModeSchema = Schema.Literals(['SUPERSEDE', 'RETRACT']);
export type RelationshipCorrectionMode = typeof RelationshipCorrectionModeSchema.Type;

const relationshipCorrectionFields = {
  ...correctionEvidenceFields,
  expectedRevision: PositiveRevisionSchema,
  factKind: Schema.Literal('RELATIONSHIP'),
  relationshipRef: PartyRelationshipRefSchema,
} as const;

export const SupersedeRelationshipCorrectionCommandSchema = Schema.Struct({
  ...relationshipCorrectionFields,
  correctionMode: Schema.Literal('SUPERSEDE'),
  replacementValidFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  replacementValidTo: Schema.NullOr(RelationshipIsoTimestampSchema),
}).check(
  Schema.makeFilter((command) =>
    command.replacementValidFrom === null ||
    command.replacementValidTo === null ||
    command.replacementValidTo > command.replacementValidFrom
      ? undefined
      : 'replacementValidTo must be later than replacementValidFrom',
  ),
);

export const RetractRelationshipCorrectionCommandSchema = Schema.Struct({
  ...relationshipCorrectionFields,
  correctionMode: Schema.Literal('RETRACT'),
});

export const RelationshipCorrectionCommandSchema = Schema.Union([
  SupersedeRelationshipCorrectionCommandSchema,
  RetractRelationshipCorrectionCommandSchema,
]);
export type RelationshipCorrectionCommand = typeof RelationshipCorrectionCommandSchema.Type;

export const PartyCorrectionCommandSchema = Schema.Union([
  IdentityCorrectionCommandSchema,
  RelationshipCorrectionCommandSchema,
]);
export type PartyCorrectionCommand = typeof PartyCorrectionCommandSchema.Type;

export const CorrectionRouteSchema = Schema.Literals([
  'ENRICHMENT_REVIEW',
  'LIFECYCLE_REVIEW',
  'CLAIM_REASSIGNMENT_REVIEW',
  'RELATIONSHIP_REVIEW',
]);
export type CorrectionRoute = typeof CorrectionRouteSchema.Type;

const correctionRoutes = {
  DISPLAY_NAME: 'ENRICHMENT_REVIEW',
  OFFICIAL_IDENTIFIER: 'CLAIM_REASSIGNMENT_REVIEW',
  PARTY_TYPE: 'LIFECYCLE_REVIEW',
  RELATIONSHIP: 'RELATIONSHIP_REVIEW',
} as const satisfies Readonly<Record<CorrectablePartyFact, CorrectionRoute>>;
export const classifyCorrectionRoute = (factKind: CorrectablePartyFact): CorrectionRoute =>
  correctionRoutes[factKind];

export const PartyCorrectionResultSchema = Schema.Struct({
  correctionRef: PartyCorrectionRefSchema,
  factKind: CorrectablePartyFactSchema,
  followUp: CorrectionRouteSchema,
  partyRef: PartyRefSchema,
  relationshipRef: Schema.NullOr(PartyRelationshipRefSchema),
  replacementAssertionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  replacementRelationshipRef: Schema.NullOr(PartyRelationshipRefSchema),
  retractedAssertionId: Schema.String.check(Schema.isUUID()),
});

export class PartyCorrectionConflict extends Schema.TaggedError<PartyCorrectionConflict>()(
  'PartyCorrectionConflict',
  {
    code: Schema.Literal('party_correction_conflict'),
    reason: Schema.String,
  },
) {}

const assertionHistoryFields = {
  assertionId: Schema.String.check(Schema.isUUID()),
  provenance: PartyRelationshipProvenanceSchema,
  recordedAt: Schema.String,
  validTo: Schema.NullOr(Schema.String),
} as const;
const AssertionStateSchema = Schema.Literals([
  'ACTIVE',
  'ENDED',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);

export const PartyCorrectionAssertionValueSchema = Schema.Union([
  Schema.Struct({
    ...assertionHistoryFields,
    factKind: Schema.Literals(['PARTY_TYPE', 'DISPLAY_NAME']),
    state: AssertionStateSchema,
    validFrom: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    ...assertionHistoryFields,
    factKind: Schema.Literal('OFFICIAL_IDENTIFIER'),
    identifierType: Schema.Literals(['ICO', 'CZ_DIC']),
    namespace: Schema.String,
    state: AssertionStateSchema,
    validFrom: Schema.String,
    value: Schema.String,
    verification: Schema.Literals(['UNVERIFIED', 'VERIFIED', 'REJECTED']),
  }),
  Schema.Struct({
    ...assertionHistoryFields,
    assertionState: Schema.Literals(['ACTIVE', 'SUPERSEDED', 'RETRACTED', 'DISPUTED']),
    endEvidence: Schema.NullOr(RelationshipEndEvidenceSchema),
    factKind: Schema.Literal('RELATIONSHIP'),
    fromPartyRef: PartyRefSchema,
    relationshipType: Schema.Literal('CONTACT_PERSON_OF'),
    toPartyRef: PartyRefSchema,
    validFrom: Schema.NullOr(Schema.String),
  }),
]);
export type PartyCorrectionAssertionValue = typeof PartyCorrectionAssertionValueSchema.Type;

export const PartyCorrectionGovernance = {
  classification: 'SENSITIVE_IDENTITY',
  legalHolds: 'HONOR_GOVERNED_LEGAL_HOLDS',
  policyVersion: PartyCorrectionPolicyVersion,
  retention: 'PRESERVE_WITH_IDENTITY_HISTORY_NO_AUTOMATIC_DELETION',
  visibility: 'RESTRICTED_IDENTITY_HISTORY',
} as const;
export const PartyCorrectionGovernanceSchema = Schema.Struct({
  classification: Schema.Literal(PartyCorrectionGovernance.classification),
  legalHolds: Schema.Literal(PartyCorrectionGovernance.legalHolds),
  policyVersion: PolicyVersionSchema,
  retention: Schema.Literal(PartyCorrectionGovernance.retention),
  visibility: Schema.Literal(PartyCorrectionGovernance.visibility),
});

export const PartyCorrectionDetailSchema = Schema.Struct({
  actingPrincipalId: Schema.String.check(Schema.isUUID()),
  actionInvocationId: Schema.String.check(Schema.isUUID()),
  approvingPrincipalId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  correctionRef: PartyCorrectionRefSchema,
  evidenceRefs: Schema.Array(Schema.String),
  evidenceSource: PartyCorrectionEvidenceSourceSchema,
  factKind: CorrectablePartyFactSchema,
  governance: PartyCorrectionGovernanceSchema,
  originalAssertion: PartyCorrectionAssertionValueSchema,
  partyRef: PartyRefSchema,
  policyVersion: PolicyVersionSchema,
  provenance: PartyRelationshipProvenanceSchema,
  reasonCode: PartyCorrectionReasonCodeSchema,
  reasonDetail: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
  relationshipRef: Schema.NullOr(PartyRelationshipRefSchema),
  replacementAssertionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  replacementRelationshipRef: Schema.NullOr(PartyRelationshipRefSchema),
  resultingAssertion: Schema.NullOr(PartyCorrectionAssertionValueSchema),
  targetAssertionId: Schema.String.check(Schema.isUUID()),
});
