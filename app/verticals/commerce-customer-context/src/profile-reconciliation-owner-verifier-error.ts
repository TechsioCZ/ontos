import { Schema } from 'effect';

export class ProfileReconciliationOwnerVerificationFailure extends Schema.TaggedError<ProfileReconciliationOwnerVerificationFailure>()(
  'ProfileReconciliationOwnerVerificationFailure',
  {
    code: Schema.Literals(['OWNER_UNAVAILABLE', 'OUTCOME_INDETERMINATE']),
    owner: Schema.String,
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
