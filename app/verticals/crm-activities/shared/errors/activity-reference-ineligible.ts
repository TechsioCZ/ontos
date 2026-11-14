import { Schema } from 'effect';

export class ActivityReferenceIneligible extends Schema.TaggedError<ActivityReferenceIneligible>()(
  'ActivityReferenceIneligible',
  {
    code: Schema.Literal('activity_reference_ineligible'),
    reason: Schema.String,
  },
) {}
