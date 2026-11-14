import { Schema } from 'effect';

/** Media storage could not be read or written; the caller's transaction must not commit a partial change. */
export class MediaStoreUnavailable extends Schema.TaggedError<MediaStoreUnavailable>()('MediaStoreUnavailable', {
  code: Schema.Literal('media_store_unavailable'),
  reason: Schema.String,
}) {}
