import { Schema } from 'effect';

export class ReadPermissionUnavailable extends Schema.TaggedError<ReadPermissionUnavailable>()(
  'ReadPermissionUnavailable',
  { code: Schema.Literal('read_permission_unavailable'), reason: Schema.String },
) {}
