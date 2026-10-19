import { Schema } from 'effect';

export class CrmPermissionDenied extends Schema.TaggedError<CrmPermissionDenied>()('CrmPermissionDenied', {
  code: Schema.Literal('crm_permission_denied'),
  reason: Schema.String,
}) {}
