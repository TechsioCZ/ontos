import { Schema } from 'effect';

/**
 * The originating Action invocation. It is a queue acknowledgement identity only and never names a
 * tenant, company, source row, projection generation or document count.
 */
export const ProjectSearchRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProjectSearchRequestId'),
);
export type ProjectSearchRequestId = typeof ProjectSearchRequestIdSchema.Type;

/** The caller chooses no tenant, company, source data or projection generation. */
export const RequestSearchRebuildPayloadSchema = Schema.Struct({});

/** Queue acknowledgement only; completed delivery, not this result, establishes projection freshness. */
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: ProjectSearchRequestIdSchema,
  status: Schema.Literal('QUEUED'),
});

export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export type RequestSearchRebuildResult = typeof RequestSearchRebuildResultSchema.Type;
