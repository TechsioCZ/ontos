import { Schema } from 'effect';

/** The binding does not exist in the exact scope of the request. */
export class PreVerificationBindingNotFound extends Schema.TaggedError<PreVerificationBindingNotFound>()(
  'PreVerificationBindingNotFound',
  { code: Schema.Literal('pre_verification_binding_not_found') },
) {}
