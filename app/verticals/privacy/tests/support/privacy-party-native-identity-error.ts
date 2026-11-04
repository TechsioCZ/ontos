import { Schema } from 'effect';

export class PrivacyPartyNativeIdentityError extends Schema.TaggedError<PrivacyPartyNativeIdentityError>()(
  'PrivacyPartyNativeIdentityError',
  { stage: Schema.String },
) {}
