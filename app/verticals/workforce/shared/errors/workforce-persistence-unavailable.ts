import { Schema } from 'effect';

export class WorkforcePersistenceUnavailable extends Schema.TaggedError<WorkforcePersistenceUnavailable>()(
  'WorkforcePersistenceUnavailable',
  {
    code: Schema.Literal('workforce_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
