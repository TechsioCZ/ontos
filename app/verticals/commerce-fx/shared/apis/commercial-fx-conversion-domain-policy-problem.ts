import { HttpApiSchema } from '@modern-js/plugin-bff/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class CommercialFxConversionDomainPolicyProblem extends Schema.TaggedError<CommercialFxConversionDomainPolicyProblem>()(
  'CommercialFxConversionDomainPolicyProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literals([
      'UNSUPPORTED_CURRENCY_PAIR',
      'PURPOSE_NOT_ALLOWED',
      'ROUNDING_RULE_MISSING',
    ]),
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CommercialFxConversionDomainPolicyProblemSchema =
  CommercialFxConversionDomainPolicyProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(422),
  );
