import { Schema } from 'effect';

export class WorkforceLifecycleConflict extends Schema.TaggedError<WorkforceLifecycleConflict>()(
  'WorkforceLifecycleConflict',
  {
    code: Schema.Literal('workforce_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
