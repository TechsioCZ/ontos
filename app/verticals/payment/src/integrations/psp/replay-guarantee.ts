import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PaymentProviderReplayGuarantee } from '../../../shared/domain/evidence-contract.ts';
import type { PaymentUnavailable } from '../../../shared/domain/payment-unavailable.ts';
import type { PaymentProviderReplayEvidenceRequest } from '../../ports/provider-replay-evidence-port.ts';

/**
 * Action-side reader of C17's retained original dispatch (#1158), mapped to the C16
 * `PaymentProviderReplayGuarantee`. It backs `PaymentProviderReplayEvidencePort`. Only a Stripe
 * dispatch with a persisted replay window yields a guarantee; it never creates a key or a window.
 */
export interface ProviderReplayGuaranteeReaderContract {
  /** `None` when no dispatch, no window, or the dispatch differs from the request's lineage. */
  readonly read: (
    request: PaymentProviderReplayEvidenceRequest,
  ) => Effect.Effect<Option.Option<PaymentProviderReplayGuarantee>, PaymentUnavailable>;
}

export class ProviderReplayGuaranteeReader extends Context.Service<
  ProviderReplayGuaranteeReader,
  ProviderReplayGuaranteeReaderContract
>()('@app/payment/integrations/psp/replay-guarantee/ProviderReplayGuaranteeReader') {}
