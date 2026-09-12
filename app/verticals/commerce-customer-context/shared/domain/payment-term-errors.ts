import { Schema } from 'effect';

export class PaymentTermsDependencyUnavailable extends Schema.TaggedError<PaymentTermsDependencyUnavailable>()(
  'PaymentTermsDependencyUnavailable',
  {
    code: Schema.Literal('payment_terms_dependency_unavailable'),
    dependency: Schema.Literals(['CUSTOMER_SETTINGS', 'PAYMENT_TERM_CATALOG', 'CUSTOMER_COMMERCE_POLICY']),
    reason: Schema.String,
  },
) {}
