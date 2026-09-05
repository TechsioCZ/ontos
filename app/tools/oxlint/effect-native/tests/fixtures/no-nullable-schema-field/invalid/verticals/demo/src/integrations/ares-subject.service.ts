// expect-count: 3
import * as Schema from 'effect/Schema';

const ContactsDateOnlySchema = Schema.String;

// Namespace submodule import; `Schema.optional(Schema.NullOr(...))` reports once, on the inner call.
export const AresSubjectSchema = Schema.Struct({
  datumVzniku: Schema.optional(Schema.NullOr(ContactsDateOnlySchema)),
  datumZaniku: Schema.optional(Schema.NullOr(ContactsDateOnlySchema)),
  dic: Schema.NullOr(Schema.String),
  obchodniJmeno: Schema.optional(Schema.String),
});
