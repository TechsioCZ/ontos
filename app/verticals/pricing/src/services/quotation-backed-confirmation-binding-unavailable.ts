import { Data } from 'effect';

export class PricingQuotationBackedConfirmationBindingUnavailable extends Data.TaggedError(
  'PricingQuotationBackedConfirmationBindingUnavailable',
)<{
  readonly reason: string;
  readonly retryable: true;
}> {}
