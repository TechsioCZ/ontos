import { Data } from 'effect';

/** Failure of the owner-private quotation reference minting boundary. */
export class PricingQuotationIssuanceUnavailable extends Data.TaggedError('PricingQuotationIssuanceUnavailable')<{
  readonly reason: 'REFERENCE_ISSUANCE_UNAVAILABLE' | 'TRUSTED_OPERATION_TIME_UNAVAILABLE';
  readonly retryable: true;
}> {}
