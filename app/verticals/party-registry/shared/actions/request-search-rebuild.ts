// Canonical schema-only contract extracted from the generated request-search-rebuild Action.
import { Schema } from 'effect';

export const RequestSearchRebuildPayloadSchema = Schema.Struct({});
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;

export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literal('QUEUED'),
});
export type RequestSearchRebuildResult = typeof RequestSearchRebuildResultSchema.Type;
