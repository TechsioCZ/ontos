import { Schema } from 'effect';

export class RecordNoticeProvisionError extends Schema.TaggedError<RecordNoticeProvisionError>()(
  'RecordNoticeProvisionError',
  {
    code: Schema.Literals(['privacy_notice_provision_invalid', 'privacy_notice_provision_scope_required']),
    reason: Schema.String,
  },
) {}
