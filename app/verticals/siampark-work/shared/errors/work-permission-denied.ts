import { Schema } from 'effect';

export class WorkPermissionDenied extends Schema.TaggedError<WorkPermissionDenied>()('WorkPermissionDenied', {
  code: Schema.Literal('work_permission_denied'),
  reason: Schema.String,
}) {}
