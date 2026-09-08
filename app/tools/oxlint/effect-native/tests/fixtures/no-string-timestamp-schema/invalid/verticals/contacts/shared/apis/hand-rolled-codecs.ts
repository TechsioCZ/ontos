// expect-count: 3
import { Schema } from 'effect';

// 1 the leap-year date-only codec, reported on the enclosing `.check(...)`
export const ContactsDateOnlySchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter((value) => (value.length === 10 ? undefined : 'bad date')),
);

// 2 the regex-validated ISO timestamp codec
export const ContactsIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);

// 3 an in-file regex const, referenced by name
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
export const InstantSchema = Schema.String.check(Schema.isPattern(isoInstantPattern));

// Consumers of the codecs above are NOT re-reported: fixing the codec fixes them all.
export const CustomerSchema = Schema.Struct({
  archivedAt: Schema.NullOr(ContactsIsoTimestampSchema),
  createdAt: ContactsIsoTimestampSchema,
  dissolvedOn: Schema.NullOr(ContactsDateOnlySchema),
  ico: Schema.String.check(Schema.isPattern(/^\d{8}$/u)),
});
