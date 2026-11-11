import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentProviderReplayGuarantee } from '../../shared/domain/evidence-contract.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentOperationKind } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export interface PaymentProviderReplayEvidenceRequest {
  readonly binding: PaymentGatewayAccountBinding;
  readonly materialHash: string;
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
  readonly paymentId: string;
  readonly scope: PaymentOwnerScope;
}

export interface PaymentProviderReplayEvidenceService {
  /** Reads C17's retained original dispatch. Implementations never create a new key or window here. */
  readonly readGuarantee: (
    request: PaymentProviderReplayEvidenceRequest,
  ) => Effect.Effect<Option.Option<PaymentProviderReplayGuarantee>, PaymentUnavailable>;
}

/** The C17 owner capability supplied by the Payment execution runtime, never by the public caller. */
export class PaymentProviderReplayEvidencePort extends Context.Service<
  PaymentProviderReplayEvidencePort,
  PaymentProviderReplayEvidenceService
>()('@app/payment/ports/provider-replay-evidence-port/PaymentProviderReplayEvidencePort') {}
