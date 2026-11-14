import { Schema } from 'effect';

export class CrmNotFound extends Schema.TaggedError<CrmNotFound>()('CrmNotFound', {
  code: Schema.Literal('crm_not_found'),
  reason: Schema.String,
}) {}
