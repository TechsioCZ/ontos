import { Schema } from 'effect';

export class AuthorizationMutationReconciliationUnavailable extends Schema.TaggedError<AuthorizationMutationReconciliationUnavailable>()(
  'AuthorizationMutationReconciliationUnavailable',
  { reason: Schema.String },
) {}
