import { Effect, Layer } from 'effect';

import { paymentDeferredOwnerPortsLive } from '../../api/payment-production-layers.ts';
import { GatewayBindingPort } from '../../src/ports/gateway-binding-port.ts';
import type { PaymentGatewayBindingEvidence } from '../../src/ports/gateway-binding-port.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import { PaymentTermEvidencePort, unavailablePaymentTermEvidence } from '../../src/ports/payment-term-evidence-port.ts';

/**
 * TEST FIXTURE: owner evidence ports that are all down. Production reads Gateway Enablement from Payment's
 * own tables; suites that prove fail-closed behaviour without a configured gateway use this instead.
 */

const gatewayDown = () =>
  Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'Fixture: no Gateway Enablement evidence route'));

export const unavailableGatewayBinding: PaymentGatewayBindingEvidence = Object.freeze({
  listEnabledBindings: gatewayDown,
  verifySelectedBinding: gatewayDown,
});

/** The same down service for every transaction. */
export const unavailableGatewayBindingForTransaction = () => unavailableGatewayBinding;

export const paymentUnavailableOwnerPortsLive = Layer.mergeAll(
  paymentDeferredOwnerPortsLive,
  Layer.succeed(GatewayBindingPort, unavailableGatewayBindingForTransaction),
  Layer.succeed(PaymentTermEvidencePort, unavailablePaymentTermEvidence),
);
