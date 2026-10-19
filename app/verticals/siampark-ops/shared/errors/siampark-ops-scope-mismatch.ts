import { Schema } from 'effect';

export class SiamparkOpsScopeMismatch extends Schema.TaggedError<SiamparkOpsScopeMismatch>()(
  'SiamparkOpsScopeMismatch',
  {
    code: Schema.Literal('siampark_ops_scope_mismatch'),
    reason: Schema.String,
  },
) {}
