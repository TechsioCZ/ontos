import { Schema } from 'effect';

export const WorkforceSearchRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('WorkforceSearchRequestId'),
);

/** The caller chooses no tenant, company, source data or projection generation. */
export const RequestSearchRebuildPayloadSchema = Schema.Struct({});

/** Queue acknowledgement only; completed delivery, not this result, establishes projection freshness. */
export const RequestSearchRebuildResultSchema = Schema.Struct({
  requestId: WorkforceSearchRequestIdSchema,
  status: Schema.Literal('QUEUED'),
});

export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export type RequestSearchRebuildResult = typeof RequestSearchRebuildResultSchema.Type;
