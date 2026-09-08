import { Schema } from 'effect';

export class SystemPrincipalContextDeniedError extends Schema.TaggedError<SystemPrincipalContextDeniedError>()(
  'SystemPrincipalContextDeniedError',
  {
    code: Schema.Literal('system_principal_context_denied'),
    reason: Schema.String,
  }
) {}
