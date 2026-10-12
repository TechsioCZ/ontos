import { Schema } from 'effect';

export class PrivacyNoticeVersionNotFound extends Schema.TaggedError<PrivacyNoticeVersionNotFound>()(
  'PrivacyNoticeVersionNotFound',
  { code: Schema.Literal('privacy_notice_version_not_found'), reason: Schema.String },
) {}
