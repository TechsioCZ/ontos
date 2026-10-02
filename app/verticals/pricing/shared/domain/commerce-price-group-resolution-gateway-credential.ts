import { Context, Effect } from 'effect';

import type {
  PriceGroupOwnerGatewayConnection,
  PriceGroupOwnerGatewayUnavailable,
} from './price-group-owner-gateway-unavailable.ts';
import { PriceGroupOwnerGatewayUnavailable as OwnerUnavailable } from './price-group-owner-gateway-unavailable.ts';

export interface CommercePriceGroupResolutionGatewayCredentialIssuer {
  readonly issue: (input: {
    readonly audience: 'commerce-customer-context';
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  }) => Effect.Effect<PriceGroupOwnerGatewayConnection, PriceGroupOwnerGatewayUnavailable>;
}

export class CommercePriceGroupResolutionGatewayCredentialService extends Context.Service<
  CommercePriceGroupResolutionGatewayCredentialService,
  CommercePriceGroupResolutionGatewayCredentialIssuer
>()(
  '@app/pricing/shared/domain/commerce-price-group-resolution-gateway-credential/CommercePriceGroupResolutionGatewayCredentialService',
) {}

export const unavailableCommercePriceGroupResolutionGatewayCredentialIssuer: CommercePriceGroupResolutionGatewayCredentialIssuer =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new OwnerUnavailable({
          owner: 'COMMERCE_ASSIGNMENT',
          reason: 'No server-owned Commerce Customer Context gateway issuer is configured',
        }),
      ),
  });
