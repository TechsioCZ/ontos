import { Schema } from 'effect';

export class GatewayRelayExchangeReplay extends Schema.TaggedError<GatewayRelayExchangeReplay>()(
  'GatewayRelayExchangeReplay',
  { reason: Schema.String },
) {}
