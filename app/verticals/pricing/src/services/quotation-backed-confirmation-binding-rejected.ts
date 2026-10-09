import { Data } from 'effect';

export class PricingQuotationBackedConfirmationBindingRejected extends Data.TaggedError(
  'PricingQuotationBackedConfirmationBindingRejected',
)<{
  readonly reason: 'ATTEMPT_CHANGED' | 'ATTEMPT_NOT_FOUND' | 'BUNDLE_CHANGED' | 'PURCHASE_CHANGED';
}> {}
