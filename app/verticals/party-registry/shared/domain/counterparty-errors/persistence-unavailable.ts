import { Schema } from 'effect';

export class CounterpartyPersistenceUnavailable extends Schema.TaggedError<CounterpartyPersistenceUnavailable>()(
  'CounterpartyPersistenceUnavailable',
  {
    code: Schema.Literal('counterparty_persistence_unavailable'),
    reason: Schema.String,
  }
) {}
