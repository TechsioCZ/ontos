import { Schema } from 'effect';

export class CommercePortalAuthAuditUnavailable extends Schema.TaggedError<CommercePortalAuthAuditUnavailable>()(
  'CommercePortalAuthAuditUnavailable',
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}
