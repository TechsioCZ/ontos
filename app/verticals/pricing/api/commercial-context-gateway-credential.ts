import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import {
  CommercialContextGatewayCredentialService,
  PricingCommercialContextUnavailable,
} from '../shared/domain/commercial-context-gateway-credential.ts';
import type { CommercialContextGatewayCredentialIssuer } from '../shared/domain/commercial-context-gateway-credential.ts';

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

const configuration = Config.all({
  apiKey: Config.Redacted('ONTOS_PRICING_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: {
    readonly audience: 'commerce-market-catalog';
    readonly compositionRevision: string;
    readonly legalEntityId: string;
  },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const unavailable = (reason: string, cause?: unknown): PricingCommercialContextUnavailable => {
  const failure = new PricingCommercialContextUnavailable({
    code: 'pricing_commercial_context_unavailable',
    reason,
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const unavailableConfigurationIssuer = (cause?: unknown): CommercialContextGatewayCredentialIssuer =>
  Object.freeze({
    issue: () => Effect.fail(unavailable('Commerce Market Catalog gateway configuration is unavailable', cause)),
  });

export const makeCommercialContextGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly shellBaseUrl: URL;
  },
  issue: GatewayContextIssue = issueApiKeyGatewayContext,
): CommercialContextGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('CommercialContextGatewayCredentialIssuer.issue')(function* issueCredential(input: {
      readonly audience: 'commerce-market-catalog';
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
          unavailable('The Commerce Market Catalog gateway credential could not be issued', cause),
        ),
      );
      if (response.compositionRevision !== input.compositionRevision) {
        return yield* unavailable('Commerce Market gateway returned a credential for a different composition revision');
      }
      return {
        baseUrl: new URL(response.apiBaseUrl, configured.shellBaseUrl),
        credential: Redacted.make(`Bearer ${response.token}`),
      };
    }),
  });

export const makeCommercialContextGatewayCredentialLayer = (issue: GatewayContextIssue = issueApiKeyGatewayContext) =>
  Layer.effect(
    CommercialContextGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: unavailableConfigurationIssuer,
        onSuccess: (configured) => makeCommercialContextGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const commercialContextGatewayCredentialLive = makeCommercialContextGatewayCredentialLayer();
