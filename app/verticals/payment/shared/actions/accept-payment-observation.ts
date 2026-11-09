import { Schema } from 'effect';

import {
  paymentOptionalEvidenceRefField,
  paymentSourceDeliveryOfferField,
  paymentSourceOptionalPaymentIdField,
  paymentSourceReceivedAtField,
  paymentSourceStatementFields,
} from '../domain/source-statement.ts';

/**
 * Qualified source statement from an integration/provider/source principal (#1151/#1152): bank or
 * accounting System of Record (also an ERP through Symmy), carrier or payment gateway. Trusted Tenant
 * and Selling Legal Entity come from the operation context, never from this body. The Payment
 * correlation is optional: an uncorrelated statement is recorded as held reconciliation debt.
 */
export const AcceptPaymentObservationPayloadSchema = Schema.Struct({
  ...paymentSourceStatementFields,
  ...paymentSourceDeliveryOfferField,
  ...paymentSourceOptionalPaymentIdField,
  ...paymentOptionalEvidenceRefField,
  ...paymentSourceReceivedAtField,
});
export type AcceptPaymentObservationPayload = typeof AcceptPaymentObservationPayloadSchema.Type;

/** The committed acceptance decision; transport success is never canonical acceptance by itself. */
export { PaymentSourceStatementResultSchema as AcceptPaymentObservationResultSchema } from '../domain/source-statement.ts';
