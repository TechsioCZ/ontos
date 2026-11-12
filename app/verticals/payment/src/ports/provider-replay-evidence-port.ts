import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentProviderReplayGuarantee } from '../../shared/domain/evidence-contract.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentOperationKind } from '../../shared/domain/payment-vocabulary.ts';
import { providerReplayEvidenceForTransaction } from '../integrations/psp/replay-guarantee-live.ts';
import type { PaymentOwnerScope } from './owner-evidence-unavailable.ts';

export interface PaymentProviderReplayEvidenceRequest {
  readonly binding: PaymentGatewayAccountBinding;
  readonly materialHash: string;
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
  readonly paymentId: string;
  readonly scope: PaymentOwnerScope;
}

export interface PaymentProviderReplayEvidenceReader {
  /** Reads C17's retained original dispatch. Implementations never create a new key or window here. */
  readonly readGuarantee: (
    request: PaymentProviderReplayEvidenceRequest,
  ) => Effect.Effect<Option.Option<PaymentProviderReplayGuarantee>, PaymentUnavailable>;
}

/** Binds the replay evidence to one Core-scoped Action transaction. */
export type PaymentProviderReplayEvidenceForTransaction = (
  transaction: ScopedTransactionExecutor,
) => PaymentProviderReplayEvidenceReader;

/**
 * The C17 owner capability, never supplied by the public caller: C17's retained dispatch ledger, read in the
 * recovery Action's own transaction. Tests replace only this reader.
 */
export const PaymentProviderReplayEvidencePort = Context.Reference<PaymentProviderReplayEvidenceForTransaction>(
  '@app/payment/ports/provider-replay-evidence-port/PaymentProviderReplayEvidencePort',
  { defaultValue: () => providerReplayEvidenceForTransaction },
);
