import { Schema } from 'effect';

export class SupportRecoveryPrincipalContextUnavailableError extends Schema.TaggedError<SupportRecoveryPrincipalContextUnavailableError>()(
  'SupportRecoveryPrincipalContextUnavailableError',
  {
    code: Schema.Literal('support_recovery_context_unavailable'),
    reason: Schema.String,
  },
) {}
