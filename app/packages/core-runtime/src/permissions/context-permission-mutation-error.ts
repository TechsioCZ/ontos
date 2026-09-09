import { Schema } from 'effect';

export class ContextPermissionMutationUnavailable extends Schema.TaggedError<ContextPermissionMutationUnavailable>()(
  'ContextPermissionMutationUnavailable',
  { reason: Schema.String },
) {}
