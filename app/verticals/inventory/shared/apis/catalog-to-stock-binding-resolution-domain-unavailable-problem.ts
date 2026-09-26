import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export class CatalogToStockBindingResolutionDomainUnavailableProblem extends Schema.TaggedError<CatalogToStockBindingResolutionDomainUnavailableProblem>()(
  'CatalogToStockBindingResolutionDomainUnavailableProblem',
  {
    detail: Schema.String,
    outcome: Schema.Literal('UNAVAILABLE'),
    reasonCode: Schema.Literals([
      'catalog_to_stock_binding_unavailable',
      'inventory_backend_configuration_persistence_unavailable',
    ]),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const CatalogToStockBindingResolutionDomainUnavailableProblemSchema =
  CatalogToStockBindingResolutionDomainUnavailableProblem.pipe(problemDetailsRepresentation, HttpApiSchema.status(503));
