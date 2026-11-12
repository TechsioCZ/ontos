import { Schema } from 'effect';

import { PaymentIdSchema, PaymentOperationKeySchema } from '../domain/payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from '../domain/payment-money.ts';
import { PaymentMethodSchema } from '../domain/payment-vocabulary.ts';
import { PaymentOperationViewSchema } from '../domain/lifecycle-views.ts';
import { PaymentPayerContactSchema } from '../domain/payment-payer-contact.ts';

/**
 * Start the one COLLECT operation of a Payment (#1148 aggregate collection invariant, #1149). The
 * caller restates the exact meaning it intends to collect; it must equal the immutable Payment meaning.
 * The operation always executes under the Payment's original execution binding (no failover).
 * `operationKey` is the business idempotency anchor: the same key and material request recover the same
 * operation, a changed request under the same key is a conflict, and a second distinct live or proven
 * COLLECT is a conflict.
 * `payerContact` is operation-scoped input, not operation material: it is not part of the material hash,
 * Reads, views or events, and it is never stored beyond dispatch preparation. Which fields a binding
 * requires is decided by its provider family (see `payerContactProblemFor`).
 */
export const StartPaymentCollectionPayloadSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  method: PaymentMethodSchema,
  operationKey: PaymentOperationKeySchema,
  payerContact: Schema.optionalKey(PaymentPayerContactSchema),
  paymentId: PaymentIdSchema,
});
export type StartPaymentCollectionPayload = typeof StartPaymentCollectionPayloadSchema.Type;

/** `replayed` is true when a new invocation recovered the existing operation identity unchanged. */
export const StartPaymentCollectionResultSchema = Schema.Struct({
  operation: PaymentOperationViewSchema,
  paymentId: PaymentIdSchema,
  replayed: Schema.Boolean,
});
export type StartPaymentCollectionResult = typeof StartPaymentCollectionResultSchema.Type;
