import { Context, Effect } from 'effect';
import type { Redacted } from 'effect';

import { PurchaseLimitFxUnavailableSchema } from './purchase-limit-fx-port.ts';
import type { PurchaseLimitFxUnavailable } from './purchase-limit-fx-port.ts';

export interface CommerceFxGatewayCredentialRequest {
  readonly audience: 'commerce-fx';
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
}

export interface CommerceFxGatewayCredentialIssuer {
  readonly issue: (
    input: CommerceFxGatewayCredentialRequest,
  ) => Effect.Effect<Redacted.Redacted, PurchaseLimitFxUnavailable>;
}

/** Server-owned credential issuer; caller sessions and request payloads are never credentials. */
export class CommerceFxGatewayCredentialService extends Context.Service<
  CommerceFxGatewayCredentialService,
  CommerceFxGatewayCredentialIssuer
>()(
  '@app/commerce-customer-context/shared/domain/commerce-fx-gateway-credential/CommerceFxGatewayCredentialService',
) {}

export const unavailableCommerceFxGatewayCredentialIssuer: CommerceFxGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        PurchaseLimitFxUnavailableSchema.make({
          code: 'purchase_limit_fx_unavailable',
          reason: 'No server-owned Commerce FX gateway credential issuer is configured',
        }),
      ),
  });
