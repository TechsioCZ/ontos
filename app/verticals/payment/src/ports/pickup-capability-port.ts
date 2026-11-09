import { Context, Effect, Schema } from 'effect';

import { PaymentEvidenceRefSchema, PaymentPickupCapabilityRefSchema } from '../../shared/domain/payment-identifiers.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export const PAYMENT_PICKUP_NOT_SUPPORTED_REASONS = [
  'CAPABILITY_NOT_CURRENT',
  'COLLECTION_NOT_SUPPORTED',
  'AMOUNT_OUTSIDE_COLLECTION_CONSTRAINTS',
] as const;
export const PaymentPickupNotSupportedReasonSchema = Schema.Literals(PAYMENT_PICKUP_NOT_SUPPORTED_REASONS);

/** Exact Current pickup/on-site collection capability (#1147/#1149). */
export const PaymentPickupCollectionCapabilitySchema = Schema.Union([
  Schema.TaggedStruct('SUPPORTED', {
    capabilityEvidenceRef: PaymentEvidenceRefSchema,
    pickupCapabilityRef: PaymentPickupCapabilityRefSchema,
  }),
  Schema.TaggedStruct('NOT_SUPPORTED', {
    pickupCapabilityRef: PaymentPickupCapabilityRefSchema,
    reason: PaymentPickupNotSupportedReasonSchema,
  }),
]);
export type PaymentPickupCollectionCapability = typeof PaymentPickupCollectionCapabilitySchema.Type;

export interface PaymentPickupCapabilityService {
  readonly verifyPickupCollection: (input: {
    readonly amount: PaymentMonetaryAmount;
    readonly pickupCapabilityRef: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentPickupCollectionCapability, PaymentOwnerEvidenceUnavailable>;
}

/** Pickup/on-site collection capability evidence (L1, L3). */
export class PickupCapabilityPort extends Context.Service<PickupCapabilityPort, PaymentPickupCapabilityService>()(
  '@app/payment/ports/pickup-capability-port/PickupCapabilityPort',
) {}

export const unavailablePickupCapability: PaymentPickupCapabilityService = Object.freeze({
  verifyPickupCollection: () =>
    Effect.fail(
      ownerEvidenceUnavailable('PICKUP_CAPABILITY', 'No pickup/on-site collection capability route is configured'),
    ),
});
