import { Schema } from 'effect';

/** The provider explicitly rejected the submission request; this is not a successful receipt. */
export class EmailDeliveryRejected extends Schema.TaggedError<EmailDeliveryRejected>()('EmailDeliveryRejected', {
  reason: Schema.Literals(['provider_rejected', 'rate_limited']),
  status: Schema.Int,
}) {}
