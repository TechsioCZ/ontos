import { Schema } from 'effect';

export class SymmyJobPrivacyDispatchError extends Schema.TaggedError<SymmyJobPrivacyDispatchError>()(
  'SymmyJobPrivacyDispatchError',
  {
    code: Schema.Literals([
      'privacy_dispatch_context_invalid',
      'privacy_dispatch_receipt_conflict',
      'privacy_dispatch_gateway_unavailable',
      'privacy_dispatch_work_unresolved',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
