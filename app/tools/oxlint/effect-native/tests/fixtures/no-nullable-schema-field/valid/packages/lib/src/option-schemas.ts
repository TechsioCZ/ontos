import { Schema } from 'effect';

// Every Option-shaped combinator: the target state of audit A2 / B5.
export const CustomerSchema = Schema.Struct({
  archivedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  dissolvedOn: Schema.OptionFromNullishOr(Schema.String),
  cursor: Schema.OptionFromUndefinedOr(Schema.String),
  nickname: Schema.OptionFromOptionalKey(Schema.String),
  bio: Schema.OptionFromOptional(Schema.String),
  legalName: Schema.String,
  nextOffset: Schema.OptionFromNullOr(Schema.Finite),
});

// A nullable combinator nested inside an Option constructor: absence is already an Option.
export const NestedSchema = Schema.Struct({
  legacy: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.String)),
  merged: Schema.OptionFromOptionalNullOr(Schema.String),
});
