import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class PriceGroupDefinitionDomainUnavailableProblem extends Schema.TaggedError<PriceGroupDefinitionDomainUnavailableProblem>()(
  'PriceGroupDefinitionDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals([
      'MULTIPLE_CURRENT_DEFINITIONS',
      'OWNER_UNAVAILABLE',
      'UNVERIFIABLE_CURRENTNESS',
      'ZERO_CURRENT_DEFINITIONS',
    ]),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const PriceGroupDefinitionDomainUnavailableProblemSchema = PriceGroupDefinitionDomainUnavailableProblem.pipe(
  problemDetailsRepresentation,
  HttpApiSchema.status(503),
);
