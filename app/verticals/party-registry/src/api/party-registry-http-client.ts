import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type { HttpApi, HttpApiClient, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import type { Redacted } from 'effect';

import { partyRegistryApi, partyRegistryApiContract } from '../../shared/api.ts';
import type { OperationContext } from '../../shared/api.ts';
import { partyRegistryClientOptions, requestCorrelationHeaderName } from './party-registry-http-client-options.ts';
import type { PartyRegistryHttpRequestContextValue } from './party-registry-http-client-options.ts';

export type { PartyRegistryHttpRequestContextValue } from './party-registry-http-client-options.ts';

type PartyRegistryApiGroups =
  typeof partyRegistryApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PartyRegistryHttpClient = HttpApiClient.Client<Extract<PartyRegistryApiGroups, HttpApiGroup.Constraint>>;

const traceparentOption = 'traceparent' as const;

export interface PartyRegistryHttpClientOptions {
  readonly baseUrl?: string | URL;
  readonly compositionRevision?: string;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly [traceparentOption]?: string;
}

export const partyRegistryHttpRequestContext = (
  options: PartyRegistryHttpClientOptions = {},
): PartyRegistryHttpRequestContextValue => {
  const { baseUrl: configuredBaseUrl, locale: requestLocale, operationContext } = options;
  const baseUrl = configuredBaseUrl ?? partyRegistryApiContract.apiPrefix;
  const requestTraceparent = options[traceparentOption];
  const transportContext =
    options.compositionRevision === undefined
      ? { baseUrl }
      : { baseUrl, compositionRevision: options.compositionRevision };
  const context = operationContext === undefined ? transportContext : { ...transportContext, operationContext };
  if (requestLocale === undefined) {
    return requestTraceparent === undefined ? context : { ...context, requestTraceparent };
  }
  return requestTraceparent === undefined
    ? { ...context, requestLocale }
    : { ...context, requestLocale, requestTraceparent };
};

export const authenticatePartyRegistryHttpRequest = (
  context: PartyRegistryHttpRequestContextValue,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  requestCorrelationHeader = requestCorrelationHeaderName,
  requestTrace?: string,
): PartyRegistryHttpRequestContextValue =>
  requestTrace === undefined
    ? { ...context, credential, requestCorrelation, requestCorrelationHeader }
    : {
        ...context,
        credential,
        requestCorrelation,
        requestCorrelationHeader,
        requestTrace,
      };

export const invokePartyRegistryHttpClient = <Success, Failure, Requirements>(
  context: PartyRegistryHttpRequestContextValue,
  operation: (client: PartyRegistryHttpClient) => Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | Schema.SchemaError, Requirements> =>
  makeEffectBffClientOptions({
    defaultApiPrefix: partyRegistryApiContract.apiPrefix,
    ...partyRegistryClientOptions(context),
  }).pipe(
    // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- #358 explicitly requires lazy uncached client construction so request metadata and credentials cannot survive across operations. expires: 2026-12-31.
    Effect.flatMap((clientOptions) => makeEffectHttpApiClient(partyRegistryApi, clientOptions)),
    Effect.flatMap(operation),
  );

export const createPartyRegistryHttpClient = (
  options: PartyRegistryHttpClientOptions = {},
): Effect.Effect<PartyRegistryHttpClient, Schema.SchemaError, never> =>
  makeEffectBffClientOptions({
    defaultApiPrefix: partyRegistryApiContract.apiPrefix,
    ...partyRegistryClientOptions(partyRegistryHttpRequestContext(options)),
  }).pipe(
    // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- #358 explicitly requires lazy uncached client construction so request metadata and credentials cannot survive across operations. expires: 2026-12-31.
    Effect.flatMap((clientOptions) => makeEffectHttpApiClient(partyRegistryApi, clientOptions)),
  );
