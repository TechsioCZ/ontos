import { Schema } from 'effect';

export class OutboxClaimLostError extends Schema.TaggedError<OutboxClaimLostError>()(
  'OutboxClaimLostError',
  { code: Schema.Literal('outbox_claim_lost'), reason: Schema.String },
) {}
