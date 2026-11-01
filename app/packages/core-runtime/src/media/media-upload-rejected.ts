import { Schema } from 'effect';

/** An upload Core refused because of its content; nothing was stored or linked. */
export class MediaUploadRejected extends Schema.TaggedError<MediaUploadRejected>()('MediaUploadRejected', {
  code: Schema.Literals(['media_content_invalid', 'media_too_large', 'media_type_unsupported']),
  reason: Schema.String,
}) {}
