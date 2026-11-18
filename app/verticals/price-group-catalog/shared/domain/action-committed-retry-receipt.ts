import { Schema } from 'effect';

const ActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PriceGroupActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

/**
 * Transport acknowledgement for an exact retry whose Action invocation committed without a saved
 * reply (committed before Core saved replies, or a saved reply that no longer decodes). Core answers
 * every other exact retry with the original result itself.
 */
export const PriceGroupActionCommittedRetryReceiptSchema = Schema.Struct({
  invocationId: ActionInvocationIdSchema,
  replay: Schema.Literal('already_committed'),
});
