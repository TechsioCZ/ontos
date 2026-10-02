import { Data } from 'effect';

export class PricingCommitmentConfirmationProofIssuanceUnavailable extends Data.TaggedError(
  'PricingCommitmentConfirmationProofIssuanceUnavailable',
)<{
  readonly cause?: unknown;
  readonly reason: 'ISSUER_UNAVAILABLE';
  readonly retryable: true;
}> {}
