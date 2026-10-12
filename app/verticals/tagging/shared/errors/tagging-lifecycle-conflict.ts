import { Schema } from 'effect';

export class TaggingLifecycleConflict extends Schema.TaggedError<TaggingLifecycleConflict>()(
  'TaggingLifecycleConflict',
  {
    code: Schema.Literal('tagging_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
