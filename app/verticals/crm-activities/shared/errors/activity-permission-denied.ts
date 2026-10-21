import { Schema } from 'effect';

export class ActivityPermissionDenied extends Schema.TaggedError<ActivityPermissionDenied>()(
  'ActivityPermissionDenied',
  {
    code: Schema.Literal('activity_permission_denied'),
    reason: Schema.String,
  },
) {}
