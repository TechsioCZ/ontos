import { Schema } from 'effect';

export class CounterpartyScopeMismatch extends Schema.TaggedError<CounterpartyScopeMismatch>()(
  'CounterpartyScopeMismatch',
  {
    code: Schema.Literal('counterparty_scope_mismatch'),
    reason: Schema.String,
  },
) {}
