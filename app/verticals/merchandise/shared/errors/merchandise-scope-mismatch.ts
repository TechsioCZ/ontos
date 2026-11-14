import { Schema } from 'effect';

export class MerchandiseScopeMismatch extends Schema.TaggedError<MerchandiseScopeMismatch>()(
  'MerchandiseScopeMismatch',
  {
    code: Schema.Literal('merchandise_scope_mismatch'),
    reason: Schema.String,
  },
) {}
