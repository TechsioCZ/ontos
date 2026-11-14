import { Schema } from 'effect';

export class TaggingRevisionConflict extends Schema.TaggedError<TaggingRevisionConflict>()('TaggingRevisionConflict', {
  code: Schema.Literal('tagging_revision_conflict'),
  reason: Schema.String,
}) {}
