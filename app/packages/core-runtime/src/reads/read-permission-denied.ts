import { Schema } from 'effect';

export class ReadPermissionDenied extends Schema.TaggedError<ReadPermissionDenied>()(
  'ReadPermissionDenied',
  { code: Schema.Literal('read_permission_denied'), reason: Schema.String }
) {}
