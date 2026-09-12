import { Schema } from 'effect';

export class PaymentTermCatalogPersistenceConflict extends Schema.TaggedError<PaymentTermCatalogPersistenceConflict>()(
  'PaymentTermCatalogPersistenceConflict',
  {
    code: Schema.Literal('payment_term_catalog_persistence_conflict'),
    conflict: Schema.Literals([
      'ACTION_INVOCATION_REUSED',
      'BUSINESS_CODE',
      'PAYMENT_TERM_ID',
      'RECONCILIATION',
      'REVISION_NUMBER',
      'SEMANTIC_DUPLICATE',
    ]),
    reason: Schema.String,
  },
) {}
