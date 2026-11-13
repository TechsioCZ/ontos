import { Layer } from 'effect';

import { PaymentNotificationRoutesLive } from '../src/config/payment-notification-route-config.ts';
import { governedPaymentTermEvidenceLive } from '../src/integrations/payment-term-evidence.ts';
import { gatewayBindingServiceForTransaction } from '../src/integrations/psp/gateway-binding-live.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort, unavailableDeliveryCapability } from '../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort } from '../src/ports/gateway-binding-port.ts';
import { PickupCapabilityPort, unavailablePickupCapability } from '../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../src/ports/refundable-items-port.ts';

/** Owner evidence whose owning modules do not publish an evidence route yet: every call is unavailable. */
export const paymentDeferredOwnerPortsLive = Layer.mergeAll(
  Layer.succeed(DeliveryCapabilityPort, unavailableDeliveryCapability),
  Layer.succeed(PickupCapabilityPort, unavailablePickupCapability),
  Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
  Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
);

/** Payment's own Current Gateway Enablement, read in the Core-scoped transaction of each Action or Read. */
export const paymentGatewayBindingLive = Layer.succeed(GatewayBindingPort, gatewayBindingServiceForTransaction);

/**
 * Every owner port of the production composition. Payment-issued binding notification routes (#1157, N11) read
 * the public origin when a binding is created, never while this layer builds, so a missing
 * `ONTOS_PAYMENT_NOTIFICATION_BASE_URL` refuses only binding creation.
 */
export const paymentProductionOwnerPortsLive = Layer.mergeAll(
  paymentDeferredOwnerPortsLive,
  paymentGatewayBindingLive,
  governedPaymentTermEvidenceLive,
  PaymentNotificationRoutesLive,
);
