import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class CurrentStockEvidenceForAvailabilityDomainUnavailableProblem extends Schema.TaggedError<CurrentStockEvidenceForAvailabilityDomainUnavailableProblem>()(
  'CurrentStockEvidenceForAvailabilityDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('current_stock_evidence_for_availability_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CurrentStockEvidenceForAvailabilityDomainUnavailableProblemSchema =
  CurrentStockEvidenceForAvailabilityDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
