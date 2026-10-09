import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

import { CatalogToStockBindingResolutionFailure } from '../domain/catalog-to-stock-binding-resolution.ts';

export const CatalogToStockBindingResolutionDomainPolicyProblemSchema = makeProblemDetailsSchema(
  'CatalogToStockBindingResolutionDomainPolicyProblem',
  422,
  {
    outcome: Schema.Literals(['AMBIGUOUS', 'UNSUPPORTED']),
    reasonCode: CatalogToStockBindingResolutionFailure.fields.reason,
  },
);
export type CatalogToStockBindingResolutionDomainPolicyProblem =
  typeof CatalogToStockBindingResolutionDomainPolicyProblemSchema.Type;
