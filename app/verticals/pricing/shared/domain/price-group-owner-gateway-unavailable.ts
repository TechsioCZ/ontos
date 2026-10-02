import { Schema } from 'effect';
import type { Redacted } from 'effect';

export class PriceGroupOwnerGatewayUnavailable extends Schema.TaggedError<PriceGroupOwnerGatewayUnavailable>()(
  'PriceGroupOwnerGatewayUnavailable',
  {
    owner: Schema.Literals(['COMMERCE_ASSIGNMENT', 'PRICE_GROUP_COMPATIBILITY']),
    reason: Schema.String,
  },
) {}

export interface PriceGroupOwnerGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}
