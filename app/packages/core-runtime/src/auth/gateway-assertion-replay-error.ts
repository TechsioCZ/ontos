import { Schema } from 'effect';

export class GatewayAssertionReplayError extends Schema.TaggedError<GatewayAssertionReplayError>()(
  'GatewayAssertionReplayError',
  { reason: Schema.String },
) {}
