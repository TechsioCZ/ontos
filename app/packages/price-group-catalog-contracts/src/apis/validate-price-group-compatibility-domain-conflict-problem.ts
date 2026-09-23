import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class ValidatePriceGroupCompatibilityDomainConflictProblem extends Schema.TaggedError<ValidatePriceGroupCompatibilityDomainConflictProblem>()(
  'ValidatePriceGroupCompatibilityDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('STALE_EXPECTED_EVIDENCE'),
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const ValidatePriceGroupCompatibilityDomainConflictProblemSchema =
  ValidatePriceGroupCompatibilityDomainConflictProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(409));
