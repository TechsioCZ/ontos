import { Schema } from 'effect';

/** A Zerops public API request, response, or asynchronous process did not succeed. */
export class ZeropsApiError extends Schema.TaggedError<ZeropsApiError>()('ZeropsApiError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
  /** Set when the eventually consistent project search has not indexed the project yet. */
  reason: Schema.optional(Schema.Literal('project_not_indexed')),
}) {}
