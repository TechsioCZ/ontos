// Shared primitives of the CRM aggregate. Owned by the crm-scaffold lane; feature lanes import, never edit.
import { Schema } from 'effect';

/** Opaque entity id (client, contact, visit, order, batch...). Generated ids are `<invocationId>-<suffix>`. */
export const EntityIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
/** ISO-8601 timestamp or date stored verbatim (state is JSON; keep it simple for every lane). */
export const IsoTimeSchema = Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(40));
export const ShortTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const LongTextSchema = Schema.Trim.check(Schema.isMaxLength(4000));
/** Principal id of whoever ran a command (Core audit has the full record). */
export const PrincipalIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
