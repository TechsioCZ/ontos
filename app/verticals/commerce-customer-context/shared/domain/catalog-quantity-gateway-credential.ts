import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import type { CommerceQuantityCatalogUnavailable } from './commerce-quantity-catalog-port.ts';

export interface CatalogQuantityGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

export interface CatalogQuantityGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'catalog';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<CatalogQuantityGatewayConnection, CommerceQuantityCatalogUnavailable>;
}

export class CatalogQuantityGatewayCredentialService extends Context.Service<
  CatalogQuantityGatewayCredentialService,
  CatalogQuantityGatewayCredentialIssuer
>()(
  '@app/commerce-customer-context/shared/domain/catalog-quantity-gateway-credential/CatalogQuantityGatewayCredentialService',
) {}

export const unavailableCatalogQuantityGatewayCredentialIssuer: CatalogQuantityGatewayCredentialIssuer = Object.freeze({
  issue: () =>
    Effect.fail({
      _tag: 'CommerceQuantityCatalogUnavailable',
      code: 'catalog_selection_unavailable',
      reason: 'No server-owned Catalog gateway credential issuer is configured',
      retryable: true,
    } satisfies CommerceQuantityCatalogUnavailable),
});
