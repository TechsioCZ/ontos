import { Schema } from 'effect';

export class SystemPrincipalContextUnavailableError extends Schema.TaggedError<SystemPrincipalContextUnavailableError>()(
  'SystemPrincipalContextUnavailableError',
  {
    code: Schema.Literal('system_principal_context_unavailable'),
    reason: Schema.String,
  }
) {}
