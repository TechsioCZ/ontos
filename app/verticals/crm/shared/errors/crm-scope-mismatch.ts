import { Schema } from 'effect';

export class CrmScopeMismatch extends Schema.TaggedError<CrmScopeMismatch>()('CrmScopeMismatch', {
  code: Schema.Literal('crm_scope_mismatch'),
  reason: Schema.String,
}) {}
