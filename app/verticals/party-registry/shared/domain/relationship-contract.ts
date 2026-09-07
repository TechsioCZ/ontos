import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';
import { PartyRelationshipRefSchema } from '../resources/party-relationship.ts';

export {
  PartyRelationshipCorrectionRequired,
  PartyRelationshipEndpointNotFound,
  PartyRelationshipEndpointTypeMismatch,
  PartyRelationshipInvalidInterval,
  PartyRelationshipMutationErrorSchema,
  PartyRelationshipNotFound,
  PartyRelationshipOverlapConflict,
  PartyRelationshipPersistenceUnavailable,
  PartyRelationshipRevisionConflict,
  PartyRelationshipTypeUnsupported,
} from './relationship-errors/index.ts';

export const ContactPersonOfRelationshipType = 'CONTACT_PERSON_OF' as const;
export const PartyRelationshipTypeSchema = Schema.Literal(ContactPersonOfRelationshipType);
export type PartyRelationshipType = typeof PartyRelationshipTypeSchema.Type;

export const RelationshipPartyTypeSchema = Schema.Literals([
  'PERSON',
  'ORGANIZATION',
  'UNRESOLVED',
]);
export type RelationshipPartyType = typeof RelationshipPartyTypeSchema.Type;

export const RelationshipIsoTimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    Schema.makeFilter((value) => {
      const parsed = DateTime.make(value);
      return Option.isNone(parsed) || DateTime.formatIso(parsed.value) !== value
        ? 'timestamp must be one canonical UTC instant with millisecond precision'
        : undefined;
    }),
  ),
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
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
  validFrom: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
} as const;

export const CreatePartyRelationshipPayloadSchema = Schema.Struct(createPayloadFields).check(
  Schema.makeFilter((payload) => {
    if (
      payload.fromPartyRef.tenantId !== payload.toPartyRef.tenantId ||
      payload.fromPartyRef.resourceId === payload.toPartyRef.resourceId
    ) {
      return 'relationship endpoints must be distinct Parties in the same Tenant';
    }
    return Option.isNone(payload.validFrom) ||
      Option.isNone(payload.validTo) ||
      DateTime.Order(payload.validTo.value, payload.validFrom.value) > 0
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
  validTo: Schema.optionalKey(Schema.OptionFromNullOr(RelationshipIsoTimestampSchema)),
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
  requestedAlias: Schema.OptionFromNullOr(PartyRefSchema),
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
  reason: Schema.OptionFromNullOr(ReasonSchema),
  recordedAt: RelationshipIsoTimestampSchema,
});
export type RelationshipEndEvidence = typeof RelationshipEndEvidenceSchema.Type;

export const UpdateRelationshipAuditEvidenceSchema = Schema.Struct({
  changeReason: ReasonSchema,
  newEndHistory: Schema.Array(RelationshipEndEvidenceSchema),
  newProvenance: PartyRelationshipProvenanceSchema,
  newValidFrom: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  newValidTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  previousEndHistory: Schema.Array(RelationshipEndEvidenceSchema),
  previousProvenance: PartyRelationshipProvenanceSchema,
  previousValidFrom: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  previousValidTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  relationshipRef: PartyRelationshipRefSchema,
});
export const UpdateRelationshipAuditEvidenceJsonSchema = Schema.toEncoded(
  UpdateRelationshipAuditEvidenceSchema,
);
export const EndRelationshipAuditEvidenceSchema = Schema.Struct({
  effectiveAt: RelationshipIsoTimestampSchema,
  newProvenance: PartyRelationshipProvenanceSchema,
  previousValidTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  reason: Schema.OptionFromNullOr(ReasonSchema),
  relationshipRef: PartyRelationshipRefSchema,
});
export const EndRelationshipAuditEvidenceJsonSchema = Schema.toEncoded(
  EndRelationshipAuditEvidenceSchema,
);

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
  validFrom: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
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

export const PartyRelationshipLifecycleEventPayloadSchema = Schema.Struct({
  fromPartyRef: PartyRefSchema,
  relationshipRef: PartyRelationshipRefSchema,
  relationshipType: PartyRelationshipTypeSchema,
  revision: PositiveRevisionSchema,
  toPartyRef: PartyRefSchema,
  validFrom: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
  validTo: Schema.OptionFromNullOr(RelationshipIsoTimestampSchema),
});
export type PartyRelationshipLifecycleEventPayload =
  typeof PartyRelationshipLifecycleEventPayloadSchema.Type;
export const PartyRelationshipLifecycleEventPayloadJsonSchema = Schema.toEncoded(
  PartyRelationshipLifecycleEventPayloadSchema,
);
export type PartyRelationshipLifecycleEventPayloadJson =
  typeof PartyRelationshipLifecycleEventPayloadJsonSchema.Type;

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
