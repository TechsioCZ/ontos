import { DateTime, Option, Schema } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { CounterpartyRolePeriodRefSchema } from '../resources/counterparty-role-period.ts';

export const CounterpartyUuidSchema = Schema.String.check(Schema.isUUID());
export const CounterpartyTextSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
);
export const CounterpartyIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'timestamp must be one canonical UTC instant with millisecond precision';
  }),
);

export const LegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: CounterpartyUuidSchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: CounterpartyUuidSchema,
});
export type LegalEntityRef = typeof LegalEntityRefSchema.Type;

export const CounterpartyProvenanceSchema = Schema.Struct({
  evidenceReference: CounterpartyTextSchema,
  method: CounterpartyTextSchema,
  reason: Schema.optionalKey(CounterpartyTextSchema),
  source: CounterpartyTextSchema,
});
export type CounterpartyProvenance = typeof CounterpartyProvenanceSchema.Type;

export const CounterpartyCreationProvenanceSchema = Schema.Struct({
  evidenceReference: CounterpartyTextSchema,
  method: CounterpartyTextSchema,
  reason: CounterpartyTextSchema,
  source: CounterpartyTextSchema,
});

/** Bounded provenance explicitly admitted to the Core success audit collector. */
export const CounterpartyAuditEvidenceSchema = Schema.Struct({
  evidenceReference: Schema.NullOr(CounterpartyTextSchema),
  provenanceMethod: CounterpartyTextSchema,
  provenanceReason: CounterpartyTextSchema,
  provenanceSource: CounterpartyTextSchema,
});

export const CounterpartyRoleTypeSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
export type CounterpartyRoleType = typeof CounterpartyRoleTypeSchema.Type;

export const CounterpartyRoleStateSchema = Schema.Literals([
  'ACTIVE',
  'ENDED',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);
export type CounterpartyRoleState = typeof CounterpartyRoleStateSchema.Type;

export const CounterpartyRolePeriodSchema = Schema.Struct({
  endProvenance: Schema.optionalKey(Schema.NullOr(CounterpartyProvenanceSchema)),
  provenance: CounterpartyProvenanceSchema,
  recordedAt: CounterpartyIsoTimestampSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  roleType: CounterpartyRoleTypeSchema,
  state: CounterpartyRoleStateSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.NullOr(CounterpartyIsoTimestampSchema),
}).check(
  Schema.makeFilter((period) =>
    period.validTo === null || period.validTo >= period.validFrom
      ? undefined
      : [{ issue: 'validTo must not precede validFrom', path: ['validTo'] }],
  ),
);
export type CounterpartyRolePeriod = typeof CounterpartyRolePeriodSchema.Type;

export const CounterpartyPartyProjectionSchema = Schema.Struct({
  archived: Schema.Boolean,
  canonicalPartyRef: PartyRefSchema,
  displayName: Schema.NullOr(CounterpartyTextSchema),
  partyType: Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']),
  storedPartyRef: PartyRefSchema,
});
export type CounterpartyPartyProjection = typeof CounterpartyPartyProjectionSchema.Type;

export const CounterpartyRecordSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  createdAt: CounterpartyIsoTimestampSchema,
  legalEntityRef: LegalEntityRefSchema,
  party: CounterpartyPartyProjectionSchema,
});
export type CounterpartyRecord = typeof CounterpartyRecordSchema.Type;

export const legalEntityRef = (tenantId: string, legalEntityId: string): LegalEntityRef => ({
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
});
