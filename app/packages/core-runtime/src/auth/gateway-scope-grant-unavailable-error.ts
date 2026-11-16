import { Schema } from 'effect';

export class GatewayScopeGrantUnavailableError extends Schema.TaggedError<GatewayScopeGrantUnavailableError>()(
  'GatewayScopeGrantUnavailableError',
  {
    reason: Schema.String,
    /** The SQLSTATE PostgreSQL refused the registration with, when it answered; never its message. */
    sqlState: Schema.optionalKey(Schema.String),
  },
) {}
