import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { PricingCommercialContextUnavailable } from './pricing-commercial-context-unavailable.ts';

export { PricingCommercialContextUnavailable } from './pricing-commercial-context-unavailable.ts';

export interface CommercialContextGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

export interface CommercialContextGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'commerce-market-catalog';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<CommercialContextGatewayConnection, PricingCommercialContextUnavailable>;
}

export class CommercialContextGatewayCredentialService extends Context.Service<
  CommercialContextGatewayCredentialService,
  CommercialContextGatewayCredentialIssuer
>()('@app/pricing/shared/domain/commercial-context-gateway-credential/CommercialContextGatewayCredentialService') {}

export const unavailableCommercialContextGatewayCredentialIssuer: CommercialContextGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new PricingCommercialContextUnavailable({
          code: 'pricing_commercial_context_unavailable',
          reason: 'No server-owned Commerce Market gateway credential issuer is configured',
          retryable: true,
        }),
      ),
  });
