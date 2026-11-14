import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';

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
  /**
   * The original binding of an already-created Payment, resolved by its stable ref in this scope: `Some` when
   * that exact family, ref and environment exists here, Current or retired, whatever the Current Gateway
   * Enablement says (disable/replace affects new Payment intents only). `None` never selects another binding.
   */
  readonly resolveOriginalBinding: (input: {
    readonly binding: PaymentGatewayAccountBinding;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<Option.Option<PaymentGatewayAccountBinding>, PaymentOwnerEvidenceUnavailable>;
  /** New Payment intent selection: the selected binding is Currently enabled and Current. */
  readonly verifySelectedBinding: (input: {
    readonly binding: PaymentGatewayAccountBinding;
    readonly customerConfigurationId: string;
    readonly scope: PaymentOwnerScope;
  }) => Effect.Effect<PaymentGatewayBindingVerification, PaymentOwnerEvidenceUnavailable>;
}

/** Binds the gateway binding evidence to one Core-scoped transaction; Payment reads its own tables there. */
export type PaymentGatewayBindingEvidenceForTransaction = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) => PaymentGatewayBindingEvidence;

/**
 * C17 gateway enablement/binding evidence (L1, L2), supplied by the composition root. Action and Read service
 * factories bind it to their own transaction and hand the bound evidence to the handler as an owner service.
 */
export class GatewayBindingPort extends Context.Service<
  GatewayBindingPort,
  PaymentGatewayBindingEvidenceForTransaction
>()('@app/payment/ports/gateway-binding-port/GatewayBindingPort') {}
