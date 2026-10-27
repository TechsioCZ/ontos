// Shared primitives of the CRM aggregate. Owned by the crm-scaffold lane; feature lanes import, never edit.
import { Schema } from 'effect';
import { CalendarDateSchema } from '@app/shared-contracts';

export { CalendarDateSchema } from '@app/shared-contracts';

/** Opaque entity id (client, contact, visit, order, batch...). Generated ids are `<invocationId>-<suffix>`. */
export const EntityIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('CrmEntityId'),
);
export type EntityId = typeof EntityIdSchema.Type;
/** Trusted generated identifiers use the same owner invariant as decoded command and state identifiers. */
export const makeEntityId = (value: string): EntityId => EntityIdSchema.make(value);
const isCalendarDate = Schema.is(CalendarDateSchema);

/** Validate the source day before the native parser can roll an impossible date into another month. */
export const IsoTimeSchema = Schema.String.check(Schema.makeFilter((value) => isCalendarDate(value.slice(0, 10)))).pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
);
export const ShortTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const LongTextSchema = Schema.Trim.check(Schema.isMaxLength(4000));
/** Principal id of whoever ran a command (Core audit has the full record). */
export const PrincipalIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('CrmPrincipalId'),
);
export type PrincipalId = typeof PrincipalIdSchema.Type;
export const makePrincipalId = (value: string): PrincipalId => PrincipalIdSchema.make(value);

/** Registry company identifiers may come from other countries; the registry owns their validation. */
export const RegistryCompanyIdSchema = Schema.String.pipe(Schema.brand('RegistryCompanyId'));

/** Eight ASCII digits with the Czech IČO checksum; only validated values are sent as official identifiers. */
export const IcoSchema = Schema.String.check(
  Schema.isPattern(/^\d{8}$/u),
  Schema.makeFilter((value: string) => {
    const digits = Array.from(value, Number);
    const sum = digits.slice(0, 7).reduce((total, digit, index) => total + digit * (8 - index), 0);
    return (11 - (sum % 11)) % 10 === digits[7];
  }),
).pipe(Schema.brand('CzechIco'));
