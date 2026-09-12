import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class PurchaseCurrencyResolutionDomainConflictProblem extends Schema.TaggedError<PurchaseCurrencyResolutionDomainConflictProblem>()(
  'PurchaseCurrencyResolutionDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('INCONSISTENT_CURRENCY_POLICY'),
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const PurchaseCurrencyResolutionDomainConflictProblemSchema =
  PurchaseCurrencyResolutionDomainConflictProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(409));
