// Public contract adapted from the Codesmith-generated commerce.order Action.
import { Schema } from 'effect';

import { OrderFinalBindingSchema } from '../domain/order-commitment.ts';
import { OrderIdempotencyKeySchema } from '../domain/order-finalization-evidence.ts';

export const RevalidateOrderCommitmentPayloadSchema = Schema.Struct({
  binding: OrderFinalBindingSchema,
  idempotencyKey: OrderIdempotencyKeySchema,
});
export { OrderProofProgressSchema as RevalidateOrderCommitmentResultSchema } from '../domain/order-commitment.ts';
export type RevalidateOrderCommitmentPayload = typeof RevalidateOrderCommitmentPayloadSchema.Type;
