// Schema-only contract extracted from the Codesmith Action.
import { Schema } from 'effect';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('RequestId'))),
  status: Schema.Literal('QUEUED'),
});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
