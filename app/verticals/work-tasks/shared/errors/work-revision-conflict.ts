import { Schema } from 'effect';

export class WorkRevisionConflict extends Schema.TaggedError<WorkRevisionConflict>()('WorkRevisionConflict', {
  code: Schema.Literal('work_revision_conflict'),
  reason: Schema.String,
}) {}
