import { Schema } from 'effect';

export class GatewayScopeGrantUnavailableError extends Schema.TaggedError<GatewayScopeGrantUnavailableError>()(
  'GatewayScopeGrantUnavailableError',
  { reason: Schema.String },
) {}
