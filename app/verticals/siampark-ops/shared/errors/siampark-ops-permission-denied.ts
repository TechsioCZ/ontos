import { Schema } from 'effect';

export class SiamparkOpsPermissionDenied extends Schema.TaggedError<SiamparkOpsPermissionDenied>()(
  'SiamparkOpsPermissionDenied',
  {
    code: Schema.Literal('siampark_ops_permission_denied'),
    reason: Schema.String,
  },
) {}
