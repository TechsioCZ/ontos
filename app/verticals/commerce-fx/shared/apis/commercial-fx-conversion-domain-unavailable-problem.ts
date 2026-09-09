import { HttpApiSchema } from '@modern-js/plugin-bff/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class CommercialFxConversionDomainUnavailableProblem extends Schema.TaggedError<CommercialFxConversionDomainUnavailableProblem>()(
  'CommercialFxConversionDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals([
      'FX_SOURCE_NOT_CONFIGURED',
      'RATE_UNAVAILABLE',
      'RATE_EXPIRED_OR_STALE',
      'SOURCE_RESULT_INDETERMINATE',
    ]),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CommercialFxConversionDomainUnavailableProblemSchema =
  CommercialFxConversionDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
