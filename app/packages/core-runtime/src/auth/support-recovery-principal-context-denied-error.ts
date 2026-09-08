import { Schema } from 'effect';

export class SupportRecoveryPrincipalContextDeniedError extends Schema.TaggedError<SupportRecoveryPrincipalContextDeniedError>()(
  'SupportRecoveryPrincipalContextDeniedError',
  { code: Schema.Literal('support_recovery_context_denied'), reason: Schema.String },
) {}
