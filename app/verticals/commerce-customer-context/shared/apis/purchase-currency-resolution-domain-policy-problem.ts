import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class PurchaseCurrencyResolutionDomainPolicyProblem extends Schema.TaggedError<PurchaseCurrencyResolutionDomainPolicyProblem>()(
  'PurchaseCurrencyResolutionDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals(['EXPLICIT_CHOICE_INVALID', 'NO_USABLE_CURRENCY']),
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const PurchaseCurrencyResolutionDomainPolicyProblemSchema = PurchaseCurrencyResolutionDomainPolicyProblem.pipe(
  problemDetailsRepresentation,
  HttpApiSchema.status(422),
);
