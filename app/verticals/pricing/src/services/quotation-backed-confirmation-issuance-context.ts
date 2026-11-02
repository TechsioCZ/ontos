import type { PricingCommitmentConfirmationIssuanceOutcome } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingQuotationBackedConfirmationIssuanceCandidate } from './quotation-backed-confirmation-issuance.service.ts';
import { Context } from 'effect';
import type { Effect } from 'effect';

export interface PricingQuotationBackedConfirmationIssuanceService {
  readonly issue: (
    input: PricingQuotationBackedConfirmationIssuanceCandidate,
  ) => Effect.Effect<PricingCommitmentConfirmationIssuanceOutcome>;
}

export class PricingQuotationBackedConfirmationIssuance extends Context.Service<
  PricingQuotationBackedConfirmationIssuance,
  PricingQuotationBackedConfirmationIssuanceService
>()(
  '@app/pricing/services/quotation-backed-confirmation-issuance-context/PricingQuotationBackedConfirmationIssuance',
) {}
