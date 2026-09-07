import { Schema } from 'effect';

export class GatewayAssertionRedemptionUnavailableError extends Schema.TaggedError<GatewayAssertionRedemptionUnavailableError>()(
  'GatewayAssertionRedemptionUnavailableError',
  { reason: Schema.String },
) {}
