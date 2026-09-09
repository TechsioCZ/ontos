import { Schema } from 'effect';

export class GuestOrderClaimConflict extends Schema.TaggedError<GuestOrderClaimConflict>()(
  'GuestOrderClaimConflict',
  {
    code: Schema.Literal('guest_order_claim_conflict'),
    reason: Schema.String,
  },
) {}
