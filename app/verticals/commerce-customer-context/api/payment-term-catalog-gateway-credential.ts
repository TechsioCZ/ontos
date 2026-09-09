import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { ApiKeyGatewayContextClientOptions } from '@app/shared-contracts/server/gateway-context-api-key';
import type { GatewayContextClientError, GatewayContextResponse } from '@app/shared-contracts';
import { Config, Effect, Layer, Redacted, Schema } from 'effect';

import { PaymentTermsDependencyUnavailable } from '../shared/domain/payment-term-errors.ts';
import { PaymentTermCatalogGatewayCredentialService } from '../shared/domain/payment-term-catalog-gateway-credential.ts';
import type { PaymentTermCatalogGatewayCredentialIssuer } from '../shared/domain/payment-term-catalog-gateway-credential.ts';

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Shell gateway URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);
const configuration = Config.all({
  apiKey: Config.redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

type GatewayContextIssue = (
  payload: {
    readonly audience: 'payment-term-catalog';
    readonly legalEntityId: string;
  },
  options: ApiKeyGatewayContextClientOptions,
) => Effect.Effect<GatewayContextResponse, GatewayContextClientError>;

const issueGatewayContextOverFetch: GatewayContextIssue = issueApiKeyGatewayContext;

const unavailable = (cause: unknown): PaymentTermsDependencyUnavailable => {
  const failure = new PaymentTermsDependencyUnavailable({
    code: 'payment_terms_dependency_unavailable',
    dependency: 'PAYMENT_TERM_CATALOG',
    reason: 'The server-owned Payment Term Catalog credential could not be issued',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const unavailableConfigurationIssuer = (
  cause: unknown,
): PaymentTermCatalogGatewayCredentialIssuer =>
  Object.freeze({
    issue: () => {
      const failure = new PaymentTermsDependencyUnavailable({
        code: 'payment_terms_dependency_unavailable',
        dependency: 'PAYMENT_TERM_CATALOG',
        reason: 'No server-owned Payment Term Catalog gateway credential issuer is configured',
      });
      Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
      return Effect.fail(failure);
    },
  });

export const makePaymentTermCatalogGatewayCredentialIssuer = (
  configured: {
    readonly apiKey: Redacted.Redacted;
    readonly baseUrl: URL;
  },
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
): PaymentTermCatalogGatewayCredentialIssuer =>
  Object.freeze({
    issue: Effect.fn('PaymentTermCatalogGatewayCredentialIssuer.issue')(
      function* issuePaymentTermCatalogGatewayCredential(input: {
        readonly audience: 'payment-term-catalog';
        readonly legalEntityId: string;
        readonly requestCorrelation: string;
      }) {
        const response = yield* issue(
          {
            audience: input.audience,
            legalEntityId: input.legalEntityId,
          },
          {
            apiKey: configured.apiKey,
            baseUrl: configured.baseUrl,
            requestCorrelation: input.requestCorrelation,
          },
        ).pipe(Effect.mapError(unavailable));
        return Redacted.make(`Bearer ${response.token}`);
      },
    ),
  });

/**
 * Success-capable production credential Layer. Configuration is deployment-owned and server-only;
 * missing or malformed configuration installs the explicit fail-closed issuer.
 */
export const makePaymentTermCatalogGatewayCredentialLayer = (
  issue: GatewayContextIssue = issueGatewayContextOverFetch,
) =>
  Layer.effect(
    PaymentTermCatalogGatewayCredentialService,
    configuration.pipe(
      Effect.match({
        onFailure: unavailableConfigurationIssuer,
        onSuccess: (configured) => makePaymentTermCatalogGatewayCredentialIssuer(configured, issue),
      }),
    ),
  );

export const paymentTermCatalogGatewayCredentialLive =
  makePaymentTermCatalogGatewayCredentialLayer();
