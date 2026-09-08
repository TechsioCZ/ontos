import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { CounterpartyRolePeriodRefSchema } from '../resources/counterparty-role-period.ts';

export const CounterpartyUuidSchema = Schema.String.check(Schema.isUUID());
const CounterpartyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const CounterpartyInstantSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'timestamp must be one canonical UTC instant with millisecond precision';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
/** JSON-compatible view retained for existing action, API, and outbox consumers. */
export const CounterpartyIsoTimestampSchema = Schema.toEncoded(CounterpartyInstantSchema);

const CounterpartyLegalEntityIdSchema = CounterpartyUuidSchema.pipe(Schema.brand('LegalEntityId'));
const CounterpartyTenantIdSchema = CounterpartyUuidSchema.pipe(Schema.brand('TenantId'));

export const LegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: Schema.toEncoded(CounterpartyLegalEntityIdSchema),
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: Schema.toEncoded(CounterpartyTenantIdSchema),
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
  evidenceReference: Schema.toEncoded(Schema.OptionFromNullOr(CounterpartyTextSchema)),
  provenanceMethod: CounterpartyTextSchema,
  provenanceReason: CounterpartyTextSchema,
  provenanceSource: CounterpartyTextSchema,
});

export const CounterpartyRoleTypeSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
export type CounterpartyRoleType = typeof CounterpartyRoleTypeSchema.Type;

const CounterpartyRoleStateSchema = Schema.Literals([
  'ACTIVE',
  'ENDED',
  'SUPERSEDED',
  'RETRACTED',
  'DISPUTED',
]);

export const CounterpartyRolePeriodSchema = Schema.Struct({
  endProvenance: Schema.toEncoded(Schema.OptionFromOptionalNullOr(CounterpartyProvenanceSchema)),
  provenance: CounterpartyProvenanceSchema,
  recordedAt: CounterpartyIsoTimestampSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  roleType: CounterpartyRoleTypeSchema,
  state: CounterpartyRoleStateSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.toEncoded(Schema.OptionFromNullOr(CounterpartyInstantSchema)),
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
  displayName: Schema.toEncoded(Schema.OptionFromNullOr(CounterpartyTextSchema)),
  partyType: Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']),
  storedPartyRef: PartyRefSchema,
});

const CounterpartyRecordSchema = Schema.Struct({
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
