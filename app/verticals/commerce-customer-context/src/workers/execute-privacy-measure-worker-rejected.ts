import { Schema } from 'effect';

export class ExecutePrivacyMeasureWorkerRejected extends Schema.TaggedError<ExecutePrivacyMeasureWorkerRejected>()(
  'ExecutePrivacyMeasureWorkerRejected',
  {
    code: Schema.Literals([
      'WORKER_CONTEXT_INVALID',
      'OWNER_GATEWAY_UNAVAILABLE',
      'OWNER_COMMIT_INDETERMINATE',
      'OWNER_RECEIPT_CONFLICT',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
