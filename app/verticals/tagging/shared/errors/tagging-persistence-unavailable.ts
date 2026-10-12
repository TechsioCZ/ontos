import { Schema } from 'effect';

export class TaggingPersistenceUnavailable extends Schema.TaggedError<TaggingPersistenceUnavailable>()(
  'TaggingPersistenceUnavailable',
  {
    code: Schema.Literal('tagging_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
