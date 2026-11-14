import { Schema } from 'effect';

/** No binding, subject, requester credentials or admission is exposed on either outcome. */
export class ExternalIdentityBindingCurrentnessError extends Schema.TaggedError<ExternalIdentityBindingCurrentnessError>()(
  'ExternalIdentityBindingCurrentnessError',
  { code: Schema.Literals(['identity_forbidden', 'identity_unavailable']) },
) {}
