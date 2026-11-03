import { Schema } from 'effect';
import { SearchRebuildRequestIdSchema } from '../domain/search-identifiers.ts';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: SearchRebuildRequestIdSchema,
  status: Schema.Literal('QUEUED'),
});

export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
