import { Layer } from 'effect';

import { governedPaymentTermEvidenceLive } from '../src/integrations/payment-term-evidence.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort, unavailableDeliveryCapability } from '../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort, unavailableGatewayBinding } from '../src/ports/gateway-binding-port.ts';
import { PaymentTermEvidencePort, unavailablePaymentTermEvidence } from '../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort, unavailablePickupCapability } from '../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../src/ports/refundable-items-port.ts';

const deferredOwnerPorts = Layer.mergeAll(
  Layer.succeed(GatewayBindingPort, unavailableGatewayBinding),
  Layer.succeed(DeliveryCapabilityPort, unavailableDeliveryCapability),
  Layer.succeed(PickupCapabilityPort, unavailablePickupCapability),
  Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
  Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
);

export const paymentUnavailableOwnerPortsLive = Layer.mergeAll(
  deferredOwnerPorts,
  Layer.succeed(PaymentTermEvidencePort, unavailablePaymentTermEvidence),
);

export const paymentProductionOwnerPortsLive = Layer.mergeAll(deferredOwnerPorts, governedPaymentTermEvidenceLive);
