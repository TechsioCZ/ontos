import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

export const CatalogToStockBindingResolutionDomainUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CatalogToStockBindingResolutionDomainUnavailableProblem',
  503,
  {
    outcome: Schema.Literal('UNAVAILABLE'),
    reasonCode: Schema.Literals([
      'catalog_to_stock_binding_unavailable',
      'inventory_backend_configuration_persistence_unavailable',
    ]),
  },
);
export type CatalogToStockBindingResolutionDomainUnavailableProblem =
  typeof CatalogToStockBindingResolutionDomainUnavailableProblemSchema.Type;
