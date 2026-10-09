import { Schema } from 'effect';

/** A Cloudflare API request failed, answered `success: false`, or returned an unexpected result. */
export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()('CloudflareApiError', {
  /** The `errors[].message` values of a `success: false` envelope, e.g. `access.api.error.not_enabled`. */
  apiMessages: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}
