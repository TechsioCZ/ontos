import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { StockSharingEligibilityRejected } from '../domain/stock-sharing-eligibility.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class StockSharingEligibilityResolutionDomainPolicyProblem extends Schema.TaggedError<StockSharingEligibilityResolutionDomainPolicyProblem>()(
  'StockSharingEligibilityResolutionDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: StockSharingEligibilityRejected.fields.reason,
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const StockSharingEligibilityResolutionDomainPolicyProblemSchema =
  StockSharingEligibilityResolutionDomainPolicyProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(422));
