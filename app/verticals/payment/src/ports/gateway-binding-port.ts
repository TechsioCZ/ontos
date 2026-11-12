import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
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

export interface PaymentGatewayBindingEvidence {
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

/** Binds the gateway binding evidence to one Core-scoped transaction; Payment reads its own tables there. */
export type PaymentGatewayBindingEvidenceForTransaction = (
  transaction: ScopedTransactionExecutor,
) => PaymentGatewayBindingEvidence;

/**
 * C17 gateway enablement/binding evidence (L1, L2), supplied by the composition root. Action and Read service
 * factories bind it to their own transaction and hand the bound evidence to the handler as an owner service.
 */
export class GatewayBindingPort extends Context.Service<
  GatewayBindingPort,
  PaymentGatewayBindingEvidenceForTransaction
>()('@app/payment/ports/gateway-binding-port/GatewayBindingPort') {}
