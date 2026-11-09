import { Context, Effect, Schema } from 'effect';

import { PaymentCodCarrierSchema } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentDeliveryOfferRefSchema, PaymentEvidenceRefSchema } from '../../shared/domain/payment-identifiers.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export const PAYMENT_COD_NOT_SUPPORTED_REASONS = [
  'OFFER_NOT_CURRENT',
  'OFFER_NOT_COD_CAPABLE',
  'AMOUNT_OUTSIDE_COD_CONSTRAINTS',
] as const;
export const PaymentCodNotSupportedReasonSchema = Schema.Literals(PAYMENT_COD_NOT_SUPPORTED_REASONS);

/**
 * Exact Current COD capability of the exact selected Delivery Offer for the exact amount (#1147/#1149).
 * A SUPPORTED answer names the carrier/shipping-service binding that collects the cash for that offer;
 * Payment records it in the COD execution binding and accepts collection evidence only from it (#1152).
 */
export const PaymentCodCapabilitySchema = Schema.Union([
  Schema.TaggedStruct('SUPPORTED', {
    capabilityEvidenceRef: PaymentEvidenceRefSchema,
    carrier: PaymentCodCarrierSchema,
    deliveryOfferRef: PaymentDeliveryOfferRefSchema,
  }),
  Schema.TaggedStruct('NOT_SUPPORTED', {
    deliveryOfferRef: PaymentDeliveryOfferRefSchema,
    reason: PaymentCodNotSupportedReasonSchema,
  }),
]);
export type PaymentCodCapability = typeof PaymentCodCapabilitySchema.Type;

export interface PaymentDeliveryCapabilityService {
  readonly verifyCashOnDelivery: (input: {
    readonly amount: PaymentMonetaryAmount;
    readonly deliveryOfferRef: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentCodCapability, PaymentOwnerEvidenceUnavailable>;
}

/** Delivery Offer / Shipping owner COD capability evidence (L1, L3). */
export class DeliveryCapabilityPort extends Context.Service<DeliveryCapabilityPort, PaymentDeliveryCapabilityService>()(
  '@app/payment/ports/delivery-capability-port/DeliveryCapabilityPort',
) {}

export const unavailableDeliveryCapability: PaymentDeliveryCapabilityService = Object.freeze({
  verifyCashOnDelivery: () =>
    Effect.fail(
      ownerEvidenceUnavailable('DELIVERY_CAPABILITY', 'No Delivery Offer COD capability route is configured'),
    ),
});
