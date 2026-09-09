import { Schema } from 'effect';

export class CustomerPaymentTermsPersistenceUnavailable extends Schema.TaggedError<CustomerPaymentTermsPersistenceUnavailable>()(
  'CustomerPaymentTermsPersistenceUnavailable',
  {
    code: Schema.Literal('customer_payment_terms_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
