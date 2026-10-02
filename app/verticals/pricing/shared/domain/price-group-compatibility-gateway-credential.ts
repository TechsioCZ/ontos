import { Context, Effect } from 'effect';

import type {
  PriceGroupOwnerGatewayConnection,
  PriceGroupOwnerGatewayUnavailable,
} from './price-group-owner-gateway-unavailable.ts';
import { PriceGroupOwnerGatewayUnavailable as OwnerUnavailable } from './price-group-owner-gateway-unavailable.ts';

export interface PriceGroupCompatibilityGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'price-group-catalog';
    readonly requestCorrelation: string;
  }) => Effect.Effect<PriceGroupOwnerGatewayConnection, PriceGroupOwnerGatewayUnavailable>;
}

export class PriceGroupCompatibilityGatewayCredentialService extends Context.Service<
  PriceGroupCompatibilityGatewayCredentialService,
  PriceGroupCompatibilityGatewayCredentialIssuer
>()(
  '@app/pricing/shared/domain/price-group-compatibility-gateway-credential/PriceGroupCompatibilityGatewayCredentialService',
) {}

export const unavailablePriceGroupCompatibilityGatewayCredentialIssuer: PriceGroupCompatibilityGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new OwnerUnavailable({
          owner: 'PRICE_GROUP_COMPATIBILITY',
          reason: 'No server-owned Price Group Catalog gateway issuer is configured',
        }),
      ),
  });
