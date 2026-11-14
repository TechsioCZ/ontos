import { Schema } from 'effect';

export class ActivityPersistenceUnavailable extends Schema.TaggedError<ActivityPersistenceUnavailable>()(
  'ActivityPersistenceUnavailable',
  {
    code: Schema.Literal('activity_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
