import { Schema } from 'effect';

export class WorkPersistenceUnavailable extends Schema.TaggedError<WorkPersistenceUnavailable>()(
  'WorkPersistenceUnavailable',
  {
    code: Schema.Literal('work_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
