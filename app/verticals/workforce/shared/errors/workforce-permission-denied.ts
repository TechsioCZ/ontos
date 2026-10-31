import { Schema } from 'effect';

export class WorkforcePermissionDenied extends Schema.TaggedError<WorkforcePermissionDenied>()(
  'WorkforcePermissionDenied',
  {
    code: Schema.Literal('workforce_permission_denied'),
    reason: Schema.String,
  },
) {}
