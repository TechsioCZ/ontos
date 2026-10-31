import type {
  PricingCommitmentConfirmationRenewalOutcome,
  PricingCommitmentConfirmationRenewalRequest,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { Context } from 'effect';
import type { Effect } from 'effect';

export interface PricingCommitmentConfirmationRenewalService {
  readonly renew: (
    request: PricingCommitmentConfirmationRenewalRequest,
  ) => Effect.Effect<PricingCommitmentConfirmationRenewalOutcome>;
}

export class PricingCommitmentConfirmationRenewal extends Context.Service<
  PricingCommitmentConfirmationRenewal,
  PricingCommitmentConfirmationRenewalService
>()('@app/pricing/services/commitment-confirmation-renewal-context/PricingCommitmentConfirmationRenewal') {}
