import { Schema } from 'effect';

export class ActivityReferenceUnavailable extends Schema.TaggedError<ActivityReferenceUnavailable>()(
  'ActivityReferenceUnavailable',
  {
    code: Schema.Literal('activity_reference_unavailable'),
    reason: Schema.String,
  },
) {}
