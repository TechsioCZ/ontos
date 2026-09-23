import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { CustomerPriceGroupCatalogUnavailable } from './price-group-errors.ts';

export interface PriceGroupCatalogGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'price-group-catalog';
    readonly requestCorrelation: string;
  }) => Effect.Effect<Redacted.Redacted, CustomerPriceGroupCatalogUnavailable>;
}

export class PriceGroupCatalogGatewayCredentialService extends Context.Service<
  PriceGroupCatalogGatewayCredentialService,
  PriceGroupCatalogGatewayCredentialIssuer
>()(
  '@app/commerce-customer-context/shared/domain/price-group-catalog-gateway-credential/PriceGroupCatalogGatewayCredentialService',
) {}

export const unavailablePriceGroupCatalogGatewayCredentialIssuer: PriceGroupCatalogGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new CustomerPriceGroupCatalogUnavailable({
          code: 'customer_price_group_catalog_unavailable',
          reason: 'No server-owned Price Group Catalog gateway credential issuer is configured',
        }),
      ),
  });
