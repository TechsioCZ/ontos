import { Schema } from 'effect';
import { SearchRequestIdSchema } from '../search-identity.ts';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: Schema.toEncoded(SearchRequestIdSchema),
  status: Schema.Literal('QUEUED'),
});
