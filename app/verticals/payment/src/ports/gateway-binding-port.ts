import { Context, Effect, Schema } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import { ownerEvidenceUnavailable } from './owner-evidence-unavailable.ts';
import type { PaymentOwnerEvidenceUnavailable, PaymentOwnerScope } from './owner-evidence-unavailable.ts';

/**
 * Current Gateway Enablement verification for an explicitly selected Provider Account Binding in
 * Customer Configuration + Selling Legal Entity scope (C17 #1155). Row order or an untrusted label
 * never selects an account; there is no fallback to another binding.
 */
export const PaymentGatewayBindingVerificationSchema = Schema.Union([
  Schema.TaggedStruct('ENABLED', { binding: PaymentGatewayAccountBindingSchema }),
  Schema.TaggedStruct('NOT_ENABLED', { binding: PaymentGatewayAccountBindingSchema }),
]);
export type PaymentGatewayBindingVerification = typeof PaymentGatewayBindingVerificationSchema.Type;

export interface PaymentGatewayBindingService {
  /** Enabled bindings offered for a new Payment intent; an outage fails, it is never an empty list. */
  readonly listEnabledBindings: (input: {
    readonly customerConfigurationId: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<readonly PaymentGatewayAccountBinding[], PaymentOwnerEvidenceUnavailable>;
  readonly verifySelectedBinding: (input: {
    readonly binding: PaymentGatewayAccountBinding;
    readonly customerConfigurationId: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentGatewayBindingVerification, PaymentOwnerEvidenceUnavailable>;
}

/** C17 gateway enablement/binding evidence (L1, L2). */
export class GatewayBindingPort extends Context.Service<GatewayBindingPort, PaymentGatewayBindingService>()(
  '@app/payment/ports/gateway-binding-port/GatewayBindingPort',
) {}

const unavailable = () =>
  Effect.fail(ownerEvidenceUnavailable('GATEWAY_BINDING', 'No C17 Gateway Enablement evidence route is configured'));

export const unavailableGatewayBinding: PaymentGatewayBindingService = Object.freeze({
  listEnabledBindings: unavailable,
  verifySelectedBinding: unavailable,
});
