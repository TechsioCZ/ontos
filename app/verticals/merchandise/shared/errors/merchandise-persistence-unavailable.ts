import { Schema } from 'effect';

export class MerchandisePersistenceUnavailable extends Schema.TaggedError<MerchandisePersistenceUnavailable>()(
  'MerchandisePersistenceUnavailable',
  {
    code: Schema.Literal('merchandise_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
