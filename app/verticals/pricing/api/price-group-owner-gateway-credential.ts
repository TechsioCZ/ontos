import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { CommercePriceGroupResolutionGatewayCredentialService } from '../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import type { CommercePriceGroupResolutionGatewayCredentialIssuer } from '../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import { PriceGroupCompatibilityGatewayCredentialService } from '../shared/domain/price-group-compatibility-gateway-credential.ts';
import type { PriceGroupCompatibilityGatewayCredentialIssuer } from '../shared/domain/price-group-compatibility-gateway-credential.ts';
import { PriceGroupOwnerGatewayUnavailable } from '../shared/domain/price-group-owner-gateway-unavailable.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Service URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);

const commerceConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_PRICING_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});
const compatibilityConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_PRICING_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type CommerceGatewayContextIssue = (
  payload: {
    readonly audience: 'commerce-customer-context';
    readonly compositionRevision: string;
    readonly legalEntityId: string;
  },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;
type CompatibilityGatewayContextIssue = (
  payload: { readonly audience: 'price-group-catalog'; readonly compositionRevision: string },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const unavailable = (
  owner: 'COMMERCE_ASSIGNMENT' | 'PRICE_GROUP_COMPATIBILITY',
  reason: string,
  cause?: unknown,
): PriceGroupOwnerGatewayUnavailable => {
  const failure = new PriceGroupOwnerGatewayUnavailable({ owner, reason });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const makeCommercePriceGroupResolutionGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly shellBaseUrl: URL;
  },
  issue: CommerceGatewayContextIssue = issueApiKeyGatewayContext,
): CommercePriceGroupResolutionGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('CommercePriceGroupResolutionGatewayCredentialIssuer.issue')(
      function* issueCommercePriceGroupResolutionCredential(input: {
        readonly audience: 'commerce-customer-context';
        readonly compositionRevision: string;
        readonly legalEntityId: string;
        readonly requestCorrelation: string;
      }) {
        const response = yield* issue(
          {
            audience: input.audience,
            compositionRevision: input.compositionRevision,
            legalEntityId: input.legalEntityId,
          },
          {
            apiKey: configured.apiKey,
            baseUrl: configured.shellBaseUrl,
            requestCorrelation: input.requestCorrelation,
          },
        ).pipe(
          Effect.mapError((cause) =>
            unavailable(
              'COMMERCE_ASSIGNMENT',
              'The Commerce Customer Context gateway credential could not be issued',
              cause,
            ),
          ),
        );
        if (response.compositionRevision !== input.compositionRevision) {
          return yield* unavailable(
            'COMMERCE_ASSIGNMENT',
            'Owner gateway returned a credential for a different composition revision',
          );
        }
        return {
          baseUrl: new URL(response.apiBaseUrl, configured.shellBaseUrl),
          credential: Redacted.make(`Bearer ${response.token}`),
        };
      },
    ),
  });

export const makePriceGroupCompatibilityGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly shellBaseUrl: URL;
  },
  issue: CompatibilityGatewayContextIssue = issueApiKeyGatewayContext,
): PriceGroupCompatibilityGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('PriceGroupCompatibilityGatewayCredentialIssuer.issue')(
      function* issuePriceGroupCompatibilityCredential(input: {
        readonly audience: 'price-group-catalog';
        readonly compositionRevision: string;
        readonly requestCorrelation: string;
      }) {
        const response = yield* issue(
          { audience: input.audience, compositionRevision: input.compositionRevision },
          {
            apiKey: configured.apiKey,
            baseUrl: configured.shellBaseUrl,
            requestCorrelation: input.requestCorrelation,
          },
        ).pipe(
          Effect.mapError((cause) =>
            unavailable(
              'PRICE_GROUP_COMPATIBILITY',
              'The Price Group Catalog gateway credential could not be issued',
              cause,
            ),
          ),
        );
        if (response.compositionRevision !== input.compositionRevision) {
          return yield* unavailable(
            'PRICE_GROUP_COMPATIBILITY',
            'Owner gateway returned a credential for a different composition revision',
          );
        }
        return {
          baseUrl: new URL(response.apiBaseUrl, configured.shellBaseUrl),
          credential: Redacted.make(`Bearer ${response.token}`),
        };
      },
    ),
  });

const unavailableCommerceConfigurationIssuer = (cause?: unknown): CommercePriceGroupResolutionGatewayCredentialIssuer =>
  Object.freeze({
    issue: () =>
      Effect.fail(
        unavailable('COMMERCE_ASSIGNMENT', 'Commerce Customer Context gateway configuration is unavailable', cause),
      ),
  });
const unavailableCompatibilityConfigurationIssuer = (cause?: unknown): PriceGroupCompatibilityGatewayCredentialIssuer =>
  Object.freeze({
    issue: () =>
      Effect.fail(
        unavailable('PRICE_GROUP_COMPATIBILITY', 'Price Group Catalog gateway configuration is unavailable', cause),
      ),
  });

export const makeCommercePriceGroupResolutionGatewayCredentialLayer = (
  issue: CommerceGatewayContextIssue = issueApiKeyGatewayContext,
) =>
  Layer.effect(
    CommercePriceGroupResolutionGatewayCredentialService,
    commerceConfiguration.pipe(
      Effect.match({
        onFailure: unavailableCommerceConfigurationIssuer,
        onSuccess: (configured) => makeCommercePriceGroupResolutionGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const makePriceGroupCompatibilityGatewayCredentialLayer = (
  issue: CompatibilityGatewayContextIssue = issueApiKeyGatewayContext,
) =>
  Layer.effect(
    PriceGroupCompatibilityGatewayCredentialService,
    compatibilityConfiguration.pipe(
      Effect.match({
        onFailure: unavailableCompatibilityConfigurationIssuer,
        onSuccess: (configured) => makePriceGroupCompatibilityGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const commercePriceGroupResolutionGatewayCredentialLive =
  makeCommercePriceGroupResolutionGatewayCredentialLayer();
export const priceGroupCompatibilityGatewayCredentialLive = makePriceGroupCompatibilityGatewayCredentialLayer();
