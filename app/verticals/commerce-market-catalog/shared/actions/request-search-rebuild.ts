import { Schema } from 'effect';

export const RequestSearchRebuildIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('MarketSearchRebuildRequestId'),
  Schema.decodeTo(Schema.String.check(Schema.isUUID())),
);

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: RequestSearchRebuildIdSchema,
  status: Schema.Literal('QUEUED'),
});
