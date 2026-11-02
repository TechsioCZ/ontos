import { Schema } from 'effect';
import { SearchRequestIdSchema } from '../domain/search.ts';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: SearchRequestIdSchema,
  status: Schema.Literal('QUEUED'),
});
