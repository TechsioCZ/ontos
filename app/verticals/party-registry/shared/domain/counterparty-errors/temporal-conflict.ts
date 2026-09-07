import { Schema } from 'effect';

export class CounterpartyTemporalConflict extends Schema.TaggedError<CounterpartyTemporalConflict>()(
  'CounterpartyTemporalConflict',
  {
    code: Schema.Literal('counterparty_temporal_conflict'),
    reason: Schema.String,
  },
) {}
