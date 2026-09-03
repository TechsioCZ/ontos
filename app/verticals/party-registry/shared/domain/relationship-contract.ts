/* eslint-disable max-classes-per-file -- This closed contract owns the complete Relationship failure vocabulary. */
import { DateTime, Option, Schema } from 'effect';
import { PartyAliasWriteRejected } from './merge-alias-resolution.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { PartyRelationshipRefSchema } from '../resources/party-relationship.ts';

export const ContactPersonOfRelationshipType = 'CONTACT_PERSON_OF' as const;
export const PartyRelationshipTypeSchema = Schema.Literal(ContactPersonOfRelationshipType);
export type PartyRelationshipType = typeof PartyRelationshipTypeSchema.Type;

export const RelationshipPartyTypeSchema = Schema.Literals([
  'PERSON',
  'ORGANIZATION',
  'UNRESOLVED',
]);
export type RelationshipPartyType = typeof RelationshipPartyTypeSchema.Type;

export const RelationshipIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isNone(parsed) || DateTime.formatIso(parsed.value) !== value
      ? 'timestamp must be one canonical UTC instant with millisecond precision'
      : undefined;
  }),
);
export type RelationshipIsoTimestamp = typeof RelationshipIsoTimestampSchema.Type;

const BoundedTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const PositiveRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);

export const PartyRelationshipProvenanceSchema = Schema.Struct({
  method: BoundedTextSchema,
  source: BoundedTextSchema,
});
export type PartyRelationshipProvenance = typeof PartyRelationshipProvenanceSchema.Type;

const createPayloadFields = {
  fromPartyRef: PartyRefSchema,
  provenance: PartyRelationshipProvenanceSchema,
  relationshipType: PartyRelationshipTypeSchema,
  toPartyRef: PartyRefSchema,
  validFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.NullOr(RelationshipIsoTimestampSchema),
} as const;

export const CreatePartyRelationshipPayloadSchema = Schema.Struct(createPayloadFields).check(
  Schema.makeFilter((payload) => {
    if (
      payload.fromPartyRef.tenantId !== payload.toPartyRef.tenantId ||
      payload.fromPartyRef.resourceId === payload.toPartyRef.resourceId
    ) {
      return 'relationship endpoints must be distinct Parties in the same Tenant';
    }
    return payload.validFrom === null ||
      payload.validTo === null ||
      payload.validTo > payload.validFrom
      ? undefined
      : 'validTo must be later than validFrom for the exclusive [from,to) interval';
  }),
);
export type CreatePartyRelationshipPayload = typeof CreatePartyRelationshipPayloadSchema.Type;

export const UpdatePartyRelationshipPayloadSchema = Schema.Struct({
  changeReason: ReasonSchema,
  expectedRevision: PositiveRevisionSchema,
  provenance: PartyRelationshipProvenanceSchema,
  relationshipRef: PartyRelationshipRefSchema,
  validFrom: Schema.optionalKey(RelationshipIsoTimestampSchema),
  validTo: Schema.optionalKey(Schema.NullOr(RelationshipIsoTimestampSchema)),
});
export type UpdatePartyRelationshipPayload = typeof UpdatePartyRelationshipPayloadSchema.Type;

export const EndPartyRelationshipPayloadSchema = Schema.Struct({
  effectiveAt: RelationshipIsoTimestampSchema,
  expectedRevision: PositiveRevisionSchema,
  provenance: PartyRelationshipProvenanceSchema,
  reason: Schema.optionalKey(ReasonSchema),
  relationshipRef: PartyRelationshipRefSchema,
});
export type EndPartyRelationshipPayload = typeof EndPartyRelationshipPayloadSchema.Type;

export const RelationshipStoredEndpointSchema = Schema.Struct({
  canonicalPartyRef: PartyRefSchema,
  requestedAlias: Schema.NullOr(PartyRefSchema),
  storedPartyRef: PartyRefSchema,
});
export type RelationshipStoredEndpoint = typeof RelationshipStoredEndpointSchema.Type;

export const PartyRelationshipStateSchema = Schema.Literals(['SCHEDULED', 'CURRENT', 'HISTORICAL']);
export type PartyRelationshipState = typeof PartyRelationshipStateSchema.Type;

export const PartyRelationshipAssertionStateSchema = Schema.Literals([
  'ACTIVE',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);
export type PartyRelationshipAssertionState = typeof PartyRelationshipAssertionStateSchema.Type;

export const RelationshipEndEvidenceSchema = Schema.Struct({
  effectiveAt: RelationshipIsoTimestampSchema,
  provenance: PartyRelationshipProvenanceSchema,
  reason: Schema.NullOr(ReasonSchema),
  recordedAt: RelationshipIsoTimestampSchema,
});
export type RelationshipEndEvidence = typeof RelationshipEndEvidenceSchema.Type;

export const UpdateRelationshipAuditEvidenceSchema = Schema.Struct({
  changeReason: ReasonSchema,
  newEndHistory: Schema.Array(RelationshipEndEvidenceSchema),
  newProvenance: PartyRelationshipProvenanceSchema,
  newValidFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  newValidTo: Schema.NullOr(RelationshipIsoTimestampSchema),
  previousEndHistory: Schema.Array(RelationshipEndEvidenceSchema),
  previousProvenance: PartyRelationshipProvenanceSchema,
  previousValidFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  previousValidTo: Schema.NullOr(RelationshipIsoTimestampSchema),
  relationshipRef: PartyRelationshipRefSchema,
});
export const EndRelationshipAuditEvidenceSchema = Schema.Struct({
  effectiveAt: RelationshipIsoTimestampSchema,
  newProvenance: PartyRelationshipProvenanceSchema,
  previousValidTo: Schema.NullOr(RelationshipIsoTimestampSchema),
  reason: Schema.NullOr(ReasonSchema),
  relationshipRef: PartyRelationshipRefSchema,
});

export const PartyRelationshipDetailSchema = Schema.Struct({
  assertionState: PartyRelationshipAssertionStateSchema,
  endHistory: Schema.Array(RelationshipEndEvidenceSchema).check(Schema.isMaxLength(1)),
  from: RelationshipStoredEndpointSchema,
  provenance: PartyRelationshipProvenanceSchema,
  recordedAt: RelationshipIsoTimestampSchema,
  relationshipRef: PartyRelationshipRefSchema,
  relationshipType: PartyRelationshipTypeSchema,
  revision: PositiveRevisionSchema,
  state: PartyRelationshipStateSchema,
  to: RelationshipStoredEndpointSchema,
  validFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.NullOr(RelationshipIsoTimestampSchema),
});
export type PartyRelationshipDetail = typeof PartyRelationshipDetailSchema.Type;

export const CreatePartyRelationshipResultSchema = Schema.Struct({
  outcome: Schema.Literals(['CREATED', 'REUSED_EXISTING']),
  relationship: PartyRelationshipDetailSchema,
});
export type CreatePartyRelationshipResult = typeof CreatePartyRelationshipResultSchema.Type;

export const ChangePartyRelationshipResultSchema = Schema.Struct({
  outcome: Schema.Literals(['CHANGED', 'UNCHANGED']),
  relationship: PartyRelationshipDetailSchema,
});
export type ChangePartyRelationshipResult = typeof ChangePartyRelationshipResultSchema.Type;

const RelationshipErrorBase = {
  reason: Schema.String,
} as const;

export class PartyRelationshipNotFound extends Schema.TaggedError<PartyRelationshipNotFound>()(
  'PartyRelationshipNotFound',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_not_found'),
  },
) {}

export class PartyRelationshipEndpointNotFound extends Schema.TaggedError<PartyRelationshipEndpointNotFound>()(
  'PartyRelationshipEndpointNotFound',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_endpoint_not_found'),
    endpoint: Schema.Literals(['from', 'to']),
    partyRef: PartyRefSchema,
  },
) {}

export class PartyRelationshipEndpointTypeMismatch extends Schema.TaggedError<PartyRelationshipEndpointTypeMismatch>()(
  'PartyRelationshipEndpointTypeMismatch',
  {
    ...RelationshipErrorBase,
    actualPartyType: RelationshipPartyTypeSchema,
    code: Schema.Literal('party_relationship_endpoint_type_mismatch'),
    endpoint: Schema.Literals(['from', 'to']),
    expectedPartyType: RelationshipPartyTypeSchema,
  },
) {}

export class PartyRelationshipTypeUnsupported extends Schema.TaggedError<PartyRelationshipTypeUnsupported>()(
  'PartyRelationshipTypeUnsupported',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_type_unsupported'),
  },
) {}

export class PartyRelationshipOverlapConflict extends Schema.TaggedError<PartyRelationshipOverlapConflict>()(
  'PartyRelationshipOverlapConflict',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_overlap_conflict'),
    conflictingRelationshipRef: Schema.optionalKey(PartyRelationshipRefSchema),
  },
) {}

export class PartyRelationshipRevisionConflict extends Schema.TaggedError<PartyRelationshipRevisionConflict>()(
  'PartyRelationshipRevisionConflict',
  {
    ...RelationshipErrorBase,
    actualRevision: PositiveRevisionSchema,
    code: Schema.Literal('party_relationship_revision_conflict'),
    expectedRevision: PositiveRevisionSchema,
  },
) {}

export class PartyRelationshipCorrectionRequired extends Schema.TaggedError<PartyRelationshipCorrectionRequired>()(
  'PartyRelationshipCorrectionRequired',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_correction_required'),
    fact: Schema.Literals(['endpoint', 'relationshipType', 'validFrom', 'validTo']),
  },
) {}

export class PartyRelationshipInvalidInterval extends Schema.TaggedError<PartyRelationshipInvalidInterval>()(
  'PartyRelationshipInvalidInterval',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_invalid_interval'),
  },
) {}

export class PartyRelationshipPersistenceUnavailable extends Schema.TaggedError<PartyRelationshipPersistenceUnavailable>()(
  'PartyRelationshipPersistenceUnavailable',
  {
    ...RelationshipErrorBase,
    code: Schema.Literal('party_relationship_persistence_unavailable'),
  },
) {}

export const PartyRelationshipMutationErrorSchema = Schema.Union([
  PartyAliasWriteRejected,
  PartyRelationshipNotFound,
  PartyRelationshipEndpointNotFound,
  PartyRelationshipEndpointTypeMismatch,
  PartyRelationshipTypeUnsupported,
  PartyRelationshipOverlapConflict,
  PartyRelationshipRevisionConflict,
  PartyRelationshipCorrectionRequired,
  PartyRelationshipInvalidInterval,
  PartyRelationshipPersistenceUnavailable,
]);

export const PartyRelationshipLifecycleEventPayloadSchema = Schema.Struct({
  fromPartyRef: PartyRefSchema,
  relationshipRef: PartyRelationshipRefSchema,
  relationshipType: PartyRelationshipTypeSchema,
  revision: PositiveRevisionSchema,
  toPartyRef: PartyRefSchema,
  validFrom: Schema.NullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.NullOr(RelationshipIsoTimestampSchema),
});
export type PartyRelationshipLifecycleEventPayload =
  typeof PartyRelationshipLifecycleEventPayloadSchema.Type;

export const partyRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});

export const partyRelationshipRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party-relationship' as const,
  tenantId,
});
