import { Schema } from 'effect';

const ActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PriceGroupActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

/** Transport acknowledgement for an exact retry whose Action invocation already committed. */
export const PriceGroupActionCommittedRetryReceiptSchema = Schema.Struct({
  invocationId: ActionInvocationIdSchema,
  replay: Schema.Literal('already_committed'),
});
