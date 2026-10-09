import type { PricingCommitmentConfirmationIssuanceOutcome } from '@app/pricing-contracts/domain/commitment-confirmation';
import { Data } from 'effect';

type BindingMismatchReason = Extract<
  PricingCommitmentConfirmationIssuanceOutcome,
  { readonly _tag: 'BINDING_MISMATCH' }
>['reason'];

export class PricingCurrentBackedConfirmationUnavailable extends Data.TaggedError(
  'PricingCurrentBackedConfirmationUnavailable',
)<{
  readonly reason: string;
  readonly retryable: boolean;
}> {}

export class PricingCurrentBackedConfirmationBindingRejected extends Data.TaggedError(
  'PricingCurrentBackedConfirmationBindingRejected',
)<{
  readonly reason: BindingMismatchReason;
}> {}
