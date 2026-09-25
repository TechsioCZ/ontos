import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

import { CatalogToStockBindingResolutionFailure } from '../domain/catalog-to-stock-binding-resolution.ts';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class CatalogToStockBindingResolutionDomainPolicyProblem extends Schema.TaggedError<CatalogToStockBindingResolutionDomainPolicyProblem>()(
  'CatalogToStockBindingResolutionDomainPolicyProblem',
  {
    detail: Schema.String,
    outcome: Schema.Literals(['AMBIGUOUS', 'UNSUPPORTED']),
    reasonCode: CatalogToStockBindingResolutionFailure.fields.reason,
    status: Schema.Literal(422),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CatalogToStockBindingResolutionDomainPolicyProblemSchema =
  CatalogToStockBindingResolutionDomainPolicyProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(422));
