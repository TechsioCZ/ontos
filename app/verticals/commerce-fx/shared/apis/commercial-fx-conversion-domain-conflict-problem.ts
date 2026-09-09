import { HttpApiSchema } from '@modern-js/plugin-bff/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class CommercialFxConversionDomainConflictProblem extends Schema.TaggedError<CommercialFxConversionDomainConflictProblem>()(
  'CommercialFxConversionDomainConflictProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('INCONSISTENT_RATE_POLICY'),
    status: Schema.Literal(409),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CommercialFxConversionDomainConflictProblemSchema =
  CommercialFxConversionDomainConflictProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(409),
  );
