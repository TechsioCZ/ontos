import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { CurrentStockEvidenceForAvailabilityRejected } from '../domain/current-stock-evidence-for-availability.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class CurrentStockEvidenceForAvailabilityDomainPolicyProblem extends Schema.TaggedError<CurrentStockEvidenceForAvailabilityDomainPolicyProblem>()(
  'CurrentStockEvidenceForAvailabilityDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: CurrentStockEvidenceForAvailabilityRejected.fields.reason,
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CurrentStockEvidenceForAvailabilityDomainPolicyProblemSchema =
  CurrentStockEvidenceForAvailabilityDomainPolicyProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(422));
