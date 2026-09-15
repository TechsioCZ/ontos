import { Schema } from 'effect';

export class InvalidPrivacyNoticeContent extends Schema.TaggedError<InvalidPrivacyNoticeContent>()(
  'InvalidPrivacyNoticeContent',
  { code: Schema.Literal('privacy_notice_content_invalid'), reason: Schema.String },
) {}
