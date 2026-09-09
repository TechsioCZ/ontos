import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { PaymentTermsDependencyUnavailable } from './payment-term-errors.ts';

export interface PaymentTermCatalogGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'payment-term-catalog';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<Redacted.Redacted, PaymentTermsDependencyUnavailable>;
}

export class PaymentTermCatalogGatewayCredentialService extends Context.Service<
  PaymentTermCatalogGatewayCredentialService,
  PaymentTermCatalogGatewayCredentialIssuer
>()(
  '@app/commerce-customer-context/shared/domain/payment-term-catalog-gateway-credential/PaymentTermCatalogGatewayCredentialService',
) {}

export const unavailablePaymentTermCatalogGatewayCredentialIssuer: PaymentTermCatalogGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new PaymentTermsDependencyUnavailable({
          code: 'payment_terms_dependency_unavailable',
          dependency: 'PAYMENT_TERM_CATALOG',
          reason: 'No server-owned Payment Term Catalog gateway credential issuer is configured',
        }),
      ),
  });
