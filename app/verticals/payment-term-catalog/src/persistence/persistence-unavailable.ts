import { Schema } from 'effect';

export class PaymentTermCatalogPersistenceUnavailable extends Schema.TaggedError<PaymentTermCatalogPersistenceUnavailable>()(
  'PaymentTermCatalogPersistenceUnavailable',
  {
    code: Schema.Literal('payment_term_catalog_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
