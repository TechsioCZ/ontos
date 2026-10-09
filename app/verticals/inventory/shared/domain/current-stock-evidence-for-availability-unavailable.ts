import { Schema } from 'effect';

export class CurrentStockEvidenceForAvailabilityUnavailable extends Schema.TaggedError<CurrentStockEvidenceForAvailabilityUnavailable>()(
  'CurrentStockEvidenceForAvailabilityUnavailable',
  {
    code: Schema.Literal('current_stock_evidence_for_availability_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
