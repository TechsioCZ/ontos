import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Schema } from 'effect';

export class PaymentTermsDependencyUnavailable extends Schema.TaggedError<PaymentTermsDependencyUnavailable>()(
  'PaymentTermsDependencyUnavailable',
  {
    catalogRejection: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals(['INCOMPATIBLE', 'BROKEN', 'UNSUPPORTED_SEMANTICS']),
        paymentTermRef: PaymentTermRefSchema,
      }),
    ),
    code: Schema.Literal('payment_terms_dependency_unavailable'),
    dependency: Schema.Literals(['CUSTOMER_SETTINGS', 'PAYMENT_TERM_CATALOG', 'CUSTOMER_COMMERCE_POLICY']),
    reason: Schema.String,
  },
) {}
