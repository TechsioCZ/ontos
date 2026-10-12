import { Schema } from 'effect';

export class TaggingScopeMismatch extends Schema.TaggedError<TaggingScopeMismatch>()('TaggingScopeMismatch', {
  code: Schema.Literal('tagging_scope_mismatch'),
  reason: Schema.String,
}) {}
