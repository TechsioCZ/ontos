import { Schema } from 'effect';

export class TaggingReferenceIneligible extends Schema.TaggedError<TaggingReferenceIneligible>()(
  'TaggingReferenceIneligible',
  {
    code: Schema.Literal('tagging_reference_ineligible'),
    reason: Schema.String,
  },
) {}
