import { Schema } from 'effect';

/** A Cloudflare API request failed, answered `success: false`, or returned an unexpected result. */
export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()('CloudflareApiError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}
