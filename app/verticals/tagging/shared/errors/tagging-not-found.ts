import { Schema } from 'effect';

export class TaggingNotFound extends Schema.TaggedError<TaggingNotFound>()('TaggingNotFound', {
  code: Schema.Literal('tagging_not_found'),
  reason: Schema.String,
}) {}
