import { Schema } from 'effect';

export class CounterpartyAccessUnavailable extends Schema.TaggedError<CounterpartyAccessUnavailable>()(
  'CounterpartyAccessUnavailable',
  {
    code: Schema.Literal('counterparty_access_unavailable'),
    reason: Schema.String,
  },
) {}
