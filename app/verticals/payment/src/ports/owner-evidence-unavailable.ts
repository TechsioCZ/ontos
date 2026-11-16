import { Schema } from 'effect';

import { PaymentLegalEntityIdSchema, PaymentTenantIdSchema } from '../../shared/domain/payment-identifiers.ts';

/** Cross-owner evidence used by Payment operations. */
export const PAYMENT_OWNER_PORTS = [
  'PAYMENT_TERM_EVIDENCE',
  'GATEWAY_BINDING',
  'DELIVERY_CAPABILITY',
  'PICKUP_CAPABILITY',
  'COMMITMENT_OUTCOME',
  'COMMITMENT_ATTEMPT',
  'REFUNDABLE_ITEMS',
] as const;
export const PaymentOwnerPortSchema = Schema.Literals(PAYMENT_OWNER_PORTS);
export type PaymentOwnerPort = typeof PaymentOwnerPortSchema.Type;

/**
 * Required owner evidence could not be verified (H1094-01=A). Fail closed: callers map it to
 * `UNAVAILABLE_TO_VERIFY` / unavailable, never to absence, NONE, an empty list or a negative fact.
 */
export class PaymentOwnerEvidenceUnavailable extends Schema.TaggedError<PaymentOwnerEvidenceUnavailable>()(
  'PaymentOwnerEvidenceUnavailable',
  {
    code: Schema.Literal('payment_owner_evidence_unavailable'),
    port: PaymentOwnerPortSchema,
    reason: Schema.String,
  },
) {}

export const ownerEvidenceUnavailable = (port: PaymentOwnerPort, reason: string): PaymentOwnerEvidenceUnavailable =>
  new PaymentOwnerEvidenceUnavailable({ code: 'payment_owner_evidence_unavailable', port, reason });

/** The trusted owner scope every port call is bound to; never taken from untrusted payload metadata. */
export const PaymentOwnerScopeSchema = Schema.Struct({
  legalEntityId: PaymentLegalEntityIdSchema,
  tenantId: PaymentTenantIdSchema,
});
export type PaymentOwnerScope = typeof PaymentOwnerScopeSchema.Type;
