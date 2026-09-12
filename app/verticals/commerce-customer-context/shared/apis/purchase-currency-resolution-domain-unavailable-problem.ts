import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class PurchaseCurrencyResolutionDomainUnavailableProblem extends Schema.TaggedError<PurchaseCurrencyResolutionDomainUnavailableProblem>()(
  'PurchaseCurrencyResolutionDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals([
      'purchasing_context_unavailable',
      'currency_policy_unavailable',
      'pricing_currency_support_unavailable',
    ]),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const PurchaseCurrencyResolutionDomainUnavailableProblemSchema =
  PurchaseCurrencyResolutionDomainUnavailableProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(503));
