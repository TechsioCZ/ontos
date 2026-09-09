import { Schema } from 'effect';

export class GuestOrderClaimRateLimited extends Schema.TaggedError<GuestOrderClaimRateLimited>()(
  'GuestOrderClaimRateLimited',
  {
    code: Schema.Literal('guest_order_claim_rate_limited'),
    reason: Schema.String,
  },
) {}
