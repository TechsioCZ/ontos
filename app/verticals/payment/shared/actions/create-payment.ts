import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Schema } from 'effect';

import { PaymentMethodBranchSelectionSchema } from '../domain/applicability-contract.ts';
import {
  PaymentCustomerConfigurationIdSchema,
  PaymentIdSchema,
  PaymentIntentKeySchema,
  PaymentPurchaseCorrelationIdSchema,
} from '../domain/payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from '../domain/payment-money.ts';
import { PaymentIntentViewSchema } from '../domain/lifecycle-views.ts';

/**
 * Create one Payment intent (#1148). The payable amount is the exact authoritative Purchase Payable
 * Amount in integer minor units (332.00 CZK is `33200`); Payment never recomputes or rounds it. The
 * method branch must be AVAILABLE under #1147 applicability at this execution; its execution binding
 * and exact term semantic evidence become immutable. `intentKey` is the business idempotency anchor:
 * the same key with the same meaning is the same Payment, a changed meaning is a conflict.
 * `predecessorPaymentId` names the intent this one replaces; the predecessor is never mutated.
 */
export const CreatePaymentPayloadSchema = Schema.Struct({
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  intentKey: PaymentIntentKeySchema,
  payableAmount: PaymentMonetaryAmountSchema,
  paymentTermRef: PaymentTermRefSchema,
  predecessorPaymentId: Schema.optionalKey(PaymentIdSchema),
  purchaseCorrelationId: PaymentPurchaseCorrelationIdSchema,
  selection: PaymentMethodBranchSelectionSchema,
});
export type CreatePaymentPayload = typeof CreatePaymentPayloadSchema.Type;

/** `replayed` is true when a new invocation recovered the already persisted intent unchanged. */
export const CreatePaymentResultSchema = Schema.Struct({
  payment: PaymentIntentViewSchema,
  replayed: Schema.Boolean,
});
export type CreatePaymentResult = typeof CreatePaymentResultSchema.Type;
