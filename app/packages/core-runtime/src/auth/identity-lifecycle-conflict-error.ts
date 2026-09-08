import { Schema } from 'effect';

export class IdentityLifecycleConflictError extends Schema.TaggedError<IdentityLifecycleConflictError>()(
  'IdentityLifecycleConflictError',
  { code: Schema.Literal('identity_lifecycle_conflict'), reason: Schema.String }
) {}
