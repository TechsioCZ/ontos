// expect-count: 5
import { Schema } from 'effect';

// An `OptionFrom*` wrapper only encodes the absence of its *own* value. Once another combinator
// intervenes, the nested nullable is a different field that still decodes to `T | null`.
export const TagsSchema = Schema.OptionFromNullOr(Schema.Array(Schema.NullOr(Schema.String)));

export const IdSchema = Schema.OptionFromNullishOr(
  Schema.Union(Schema.UndefinedOr(Schema.String), Schema.Finite),
);

export const MetaSchema = Schema.OptionFromOptionalKey(
  Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
);

// `Schema.Option` codes an Option *payload*; it does not encode the payload's own absence.
export const PayloadSchema = Schema.Option(Schema.NullOr(Schema.String));

// Control: the identical element schema without the outer wrapper is reported today.
export const BareTagsSchema = Schema.Array(Schema.NullOr(Schema.String));
