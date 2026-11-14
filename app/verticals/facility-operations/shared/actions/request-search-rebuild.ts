import { Schema } from 'effect';
import { SearchRequestIdSchema } from '../domain/search-identifiers.ts';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: SearchRequestIdSchema,
  status: Schema.Literal('QUEUED'),
});

export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
