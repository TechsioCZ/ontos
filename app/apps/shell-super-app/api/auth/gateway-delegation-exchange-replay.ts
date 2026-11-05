import { Schema } from 'effect';

export class GatewayDelegationExchangeReplay extends Schema.TaggedError<GatewayDelegationExchangeReplay>()(
  'GatewayDelegationExchangeReplay',
  { reason: Schema.String },
) {}
