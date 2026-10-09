import { Schema } from 'effect';

export class PrivacyOperationPersistenceError extends Schema.TaggedError<PrivacyOperationPersistenceError>()(
  'PrivacyOperationPersistenceError',
  {
    code: Schema.Literals([
      'privacy_operation_conflict',
      'privacy_operation_not_found',
      'privacy_operation_persistence_unavailable',
      'privacy_operation_scope_mismatch',
    ]),
    reason: Schema.String,
  },
) {}
