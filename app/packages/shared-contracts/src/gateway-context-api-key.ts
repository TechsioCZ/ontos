import {
  ApiKeyGatewayContextRequestSchema,
  GatewayContextApi,
  shellGatewayContextContract,
} from './gateway-context.ts';
import type {
  ApiKeyGatewayContextRequest,
  GatewayContextClientError,
  GatewayContextResponse,
} from './gateway-context.ts';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Context, Effect, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

export interface ApiKeyGatewayContextClientOptions {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string | URL;
  readonly requestCorrelation: string;
}

interface ApiKeyGatewayContextTransportOptions {
  readonly baseUrl: string | URL;
  readonly requestCorrelation: string;
}

const ApiKeyGatewayContextTransport = Context.Reference<Option.Option<ApiKeyGatewayContextTransportOptions>>(
  '@app/shared-contracts/gateway-context-api-key/ApiKeyGatewayContextTransport',
  {
    defaultValue: Option.none,
  },
);

const apiKeyGatewayContextClient = makeEffectHttpApiClient(GatewayContextApi, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    ApiKeyGatewayContextTransport.pipe(
      Effect.map(
        Option.match({
          onNone: () => request,
          onSome: (options) =>
            HttpClientRequest.setHeader(
              HttpClientRequest.prependUrl(request, options.baseUrl.toString()),
              'x-correlation-id',
              options.requestCorrelation,
            ),
        }),
      ),
    ),
  ),
});

/**
 * Server-only client for Shell-owned API-key capability issuance.
 *
 * The API key authenticates the calling deployment to Shell. Shell resolves its bound Principal
 * and Tenant, validates the requested Legal Entity, and issues a fresh audience-scoped assertion.
 */
export const issueApiKeyGatewayContext = (
  payload: ApiKeyGatewayContextRequest,
  options: ApiKeyGatewayContextClientOptions,
): Effect.Effect<GatewayContextResponse, GatewayContextClientError> =>
  Schema.decodeEffect(ApiKeyGatewayContextRequestSchema)(payload).pipe(
    Effect.flatMap((decodedPayload) =>
      apiKeyGatewayContextClient.pipe(
        Effect.flatMap((client) =>
          client.gatewayContext.issueApiKeyGatewayContext({
            headers: { 'x-api-key': Redacted.value(options.apiKey) },
            payload: decodedPayload,
          }),
        ),
      ),
    ),
    Effect.updateService(ApiKeyGatewayContextTransport, () =>
      Option.some({
        baseUrl: options.baseUrl,
        requestCorrelation: options.requestCorrelation,
      }),
    ),
  );

export const defaultShellGatewayApiBaseUrl = shellGatewayContextContract.apiPrefix;
