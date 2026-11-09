import { Schema } from 'effect';

import {
  PaymentAuthorizationBindingSchema,
  PaymentAuthorizationProofSchema,
  PaymentAuthorizationValiditySecondsSchema,
} from '../domain/authorization-proof.ts';
import { PaymentAuthorizationIssuanceKeySchema } from '../domain/payment-identifiers.ts';

/**
 * Issue one Payment Authorization for one exact Order Commitment Attempt (#1149). The binding is the
 * exact purchase material the Attempt carries; every field must equal the Payment's immutable
 * meaning. The same issuance key returns the original immutable proof with its original times.
 */
export const IssuePaymentAuthorizationPayloadSchema = Schema.Struct({
  binding: PaymentAuthorizationBindingSchema,
  issuanceKey: PaymentAuthorizationIssuanceKeySchema,
  /** Requested validity window; the owner caps it at PAYMENT_AUTHORIZATION_MAXIMUM_VALIDITY_SECONDS. */
  validitySeconds: PaymentAuthorizationValiditySecondsSchema,
});
export type IssuePaymentAuthorizationPayload = typeof IssuePaymentAuthorizationPayloadSchema.Type;

/** ISSUED for a new proof; REPLAYED returns the original proof unchanged and implies no Current validity. */
export const IssuePaymentAuthorizationResultSchema = Schema.Struct({
  issuance: Schema.Literals(['ISSUED', 'REPLAYED']),
  proof: PaymentAuthorizationProofSchema,
});
export type IssuePaymentAuthorizationResult = typeof IssuePaymentAuthorizationResultSchema.Type;
