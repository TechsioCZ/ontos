import { Schema } from 'effect';
import { SearchRequestIdJsonSchema } from '../resources/search-identifiers.ts';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: SearchRequestIdJsonSchema,
  status: Schema.Literal('QUEUED'),
});
