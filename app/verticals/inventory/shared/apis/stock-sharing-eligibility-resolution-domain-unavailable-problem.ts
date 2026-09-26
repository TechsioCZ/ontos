import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class StockSharingEligibilityResolutionDomainUnavailableProblem extends Schema.TaggedError<StockSharingEligibilityResolutionDomainUnavailableProblem>()(
  'StockSharingEligibilityResolutionDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('stock_sharing_eligibility_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const StockSharingEligibilityResolutionDomainUnavailableProblemSchema =
  StockSharingEligibilityResolutionDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
