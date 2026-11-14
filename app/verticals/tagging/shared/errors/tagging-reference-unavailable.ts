import { Schema } from 'effect';

export class TaggingReferenceUnavailable extends Schema.TaggedError<TaggingReferenceUnavailable>()(
  'TaggingReferenceUnavailable',
  {
    code: Schema.Literal('tagging_reference_unavailable'),
    reason: Schema.String,
  },
) {}
