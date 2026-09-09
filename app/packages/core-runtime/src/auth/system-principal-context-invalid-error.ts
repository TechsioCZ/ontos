import { Schema } from 'effect';

export class SystemPrincipalContextInvalidError extends Schema.TaggedError<SystemPrincipalContextInvalidError>()(
  'SystemPrincipalContextInvalidError',
  {
    code: Schema.Literal('system_principal_context_invalid'),
    reason: Schema.String,
  },
) {}
