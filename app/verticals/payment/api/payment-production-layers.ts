import { Layer } from 'effect';

import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort, unavailableDeliveryCapability } from '../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort, unavailableGatewayBinding } from '../src/ports/gateway-binding-port.ts';
import { PaymentTermEvidencePort, unavailablePaymentTermEvidence } from '../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort, unavailablePickupCapability } from '../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../src/ports/refundable-items-port.ts';

/**
 * Explicit local/default owner evidence: every cross-owner port fails closed as unavailable until
 * deployment composition supplies a trusted owner route (H1094-01=A). Required evidence that cannot
 * be verified is never absence, NONE or a silent fallback.
 */
export const paymentUnavailableOwnerPortsLive = Layer.mergeAll(
  Layer.succeed(PaymentTermEvidencePort, unavailablePaymentTermEvidence),
  Layer.succeed(GatewayBindingPort, unavailableGatewayBinding),
  Layer.succeed(DeliveryCapabilityPort, unavailableDeliveryCapability),
  Layer.succeed(PickupCapabilityPort, unavailablePickupCapability),
  Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
  Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
);
