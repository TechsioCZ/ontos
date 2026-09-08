import { Schema } from 'effect';

export class IdentityTargetInvalidError extends Schema.TaggedError<IdentityTargetInvalidError>()(
  'IdentityTargetInvalidError',
  { code: Schema.Literal('identity_target_invalid'), reason: Schema.String }
) {}
