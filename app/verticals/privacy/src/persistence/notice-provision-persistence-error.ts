import { Schema } from 'effect';

export class NoticeProvisionPersistenceError extends Schema.TaggedError<NoticeProvisionPersistenceError>()(
  'NoticeProvisionPersistenceError',
  {
    code: Schema.Literals([
      'privacy_notice_provision_persistence_unavailable',
      'privacy_notice_provision_identity_conflict',
    ]),
    reason: Schema.String,
  },
) {}
