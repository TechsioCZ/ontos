import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { PricingCatalogSelectionUnavailable } from './pricing-catalog-selection-unavailable.ts';

export { PricingCatalogSelectionUnavailable } from './pricing-catalog-selection-unavailable.ts';

export interface CatalogSelectionGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

export interface CatalogSelectionGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'catalog';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<CatalogSelectionGatewayConnection, PricingCatalogSelectionUnavailable>;
}

export class CatalogSelectionGatewayCredentialService extends Context.Service<
  CatalogSelectionGatewayCredentialService,
  CatalogSelectionGatewayCredentialIssuer
>()('@app/pricing/shared/domain/catalog-selection-gateway-credential/CatalogSelectionGatewayCredentialService') {}

export const unavailableCatalogSelectionGatewayCredentialIssuer: CatalogSelectionGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new PricingCatalogSelectionUnavailable({
          code: 'pricing_catalog_selection_unavailable',
          reason: 'No server-owned Catalog gateway credential issuer is configured',
          retryable: true,
        }),
      ),
  });
