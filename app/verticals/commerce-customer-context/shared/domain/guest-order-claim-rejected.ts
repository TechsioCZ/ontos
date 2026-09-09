import { Schema } from 'effect';

export class GuestOrderClaimRejected extends Schema.TaggedError<GuestOrderClaimRejected>()(
  'GuestOrderClaimRejected',
  {
    code: Schema.Literal('guest_order_claim_rejected'),
    reason: Schema.String,
    reasonCode: Schema.Literals([
      'CLAIM_CONFLICT',
      'NOT_GUEST_ORDER',
      'PROOF_REJECTED',
      'RATE_LIMITED',
      'RECORD_NOT_CLAIMABLE',
      'VERIFICATION_REQUIRED',
    ]),
  },
) {}
