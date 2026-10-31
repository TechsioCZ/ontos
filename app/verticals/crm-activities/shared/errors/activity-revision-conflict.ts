import { Schema } from 'effect';

export class ActivityRevisionConflict extends Schema.TaggedError<ActivityRevisionConflict>()(
  'ActivityRevisionConflict',
  {
    code: Schema.Literal('activity_revision_conflict'),
    reason: Schema.String,
  },
) {}
