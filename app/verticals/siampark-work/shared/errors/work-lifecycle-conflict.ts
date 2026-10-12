import { Schema } from 'effect';

export class WorkLifecycleConflict extends Schema.TaggedError<WorkLifecycleConflict>()('WorkLifecycleConflict', {
  code: Schema.Literal('work_lifecycle_conflict'),
  reason: Schema.String,
}) {}
