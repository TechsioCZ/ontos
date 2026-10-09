import { Schema } from 'effect';

export class StorefrontAdministrationPersistenceUnavailable extends Schema.TaggedError<StorefrontAdministrationPersistenceUnavailable>()(
  'StorefrontAdministrationPersistenceUnavailable',
  {
    code: Schema.Literal('storefront_administration_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
