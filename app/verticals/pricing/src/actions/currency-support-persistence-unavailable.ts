import { Schema } from 'effect';

export class CurrencySupportPersistenceUnavailable extends Schema.TaggedError<CurrencySupportPersistenceUnavailable>()(
  'CurrencySupportPersistenceUnavailable',
  { reason: Schema.String },
) {}
