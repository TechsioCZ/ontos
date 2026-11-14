import { Schema } from 'effect';

export class CrmPersistenceUnavailable extends Schema.TaggedError<CrmPersistenceUnavailable>()(
  'CrmPersistenceUnavailable',
  {
    code: Schema.Literal('crm_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
