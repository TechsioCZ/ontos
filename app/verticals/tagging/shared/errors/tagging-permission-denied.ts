import { Schema } from 'effect';

export class TaggingPermissionDenied extends Schema.TaggedError<TaggingPermissionDenied>()('TaggingPermissionDenied', {
  code: Schema.Literal('tagging_permission_denied'),
  reason: Schema.String,
}) {}
