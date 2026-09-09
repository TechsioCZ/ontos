import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { EffectBffClientOptions, EffectBffRequestContext } from '@app/shared-contracts/client-runtime';
import { Effect } from '@modern-js/plugin-bff/effect-client';
import type { HttpApi, HttpApiClient, HttpApiGroup, Schema } from '@modern-js/plugin-bff/effect-client';
import { Redacted } from 'effect';

import { partyRegistryApi, partyRegistryApiContract } from '../../shared/api.ts';
import type { OperationContext } from '../../shared/api.ts';

type PartyRegistryApiGroups =
  typeof partyRegistryApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PartyRegistryHttpClient = HttpApiClient.Client<Extract<PartyRegistryApiGroups, HttpApiGroup.Constraint>>;

const traceparentOption = 'traceparent' as const;
const requestCorrelationHeaderName = 'x-correlation-id' as const;

export interface PartyRegistryHttpClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly [traceparentOption]?: string;
}

export interface PartyRegistryHttpRequestContextValue {
  readonly baseUrl: string | URL;
  readonly credential?: Redacted.Redacted<string>;
  readonly operationContext?: OperationContext;
  readonly requestCorrelationHeader?: 'x-correlation-id';
  readonly requestCorrelation?: string;
  readonly requestLocale?: string;
  readonly requestTrace?: string;
  readonly requestTraceparent?: string;
}

export const partyRegistryHttpRequestContext = (
  options: PartyRegistryHttpClientOptions = {},
): PartyRegistryHttpRequestContextValue => {
  const { baseUrl: configuredBaseUrl, locale: requestLocale, operationContext } = options;
  const baseUrl = configuredBaseUrl ?? partyRegistryApiContract.apiPrefix;
  const requestTraceparent = options[traceparentOption];
  const context = operationContext === undefined ? { baseUrl } : { baseUrl, operationContext };
  if (requestLocale === undefined) {
    return requestTraceparent === undefined ? context : { ...context, requestTraceparent };
  }
  return requestTraceparent === undefined
    ? { ...context, requestLocale }
    : { ...context, requestLocale, requestTraceparent };
};

export const authenticatePartyRegistryHttpRequest = (
  context: PartyRegistryHttpRequestContextValue,
  credential: Redacted.Redacted<string>,
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

const effectBffClientOptions = (context: PartyRegistryHttpRequestContextValue): EffectBffClientOptions => {
  const requestCorrelationHeader = context.requestCorrelationHeader ?? requestCorrelationHeaderName;
  const transportHeaders =
    context.credential === undefined || context.requestCorrelation === undefined
      ? undefined
      : {
          authorization: Redacted.value(context.credential),
          [requestCorrelationHeader]: context.requestCorrelation,
          'x-trace-id': context.requestTrace,
        };
  const requestContext: EffectBffRequestContext = {};
  if (context.requestLocale !== undefined) {
    Object.assign(requestContext, { locale: context.requestLocale });
  }
  if (context.operationContext !== undefined) {
    Object.assign(requestContext, {
      operationContext: context.operationContext,
    });
  }
  if (context.requestTraceparent !== undefined) {
    Object.assign(requestContext, { traceparent: context.requestTraceparent });
  }
  const options: EffectBffClientOptions = { baseUrl: context.baseUrl };
  if (Object.keys(requestContext).length > 0) {
    Object.assign(options, { requestContext });
  }
  if (transportHeaders !== undefined) {
    Object.assign(options, { transportHeaders });
  }
  return options;
};

export const invokePartyRegistryHttpClient = <Success, Failure, Requirements>(
  context: PartyRegistryHttpRequestContextValue,
  operation: (client: PartyRegistryHttpClient) => Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | Schema.SchemaError, Requirements> =>
  makeEffectBffClient({
    api: partyRegistryApi,
    defaultApiPrefix: partyRegistryApiContract.apiPrefix,
    ...effectBffClientOptions(context),
  }).pipe(Effect.flatMap(operation));

export const createPartyRegistryHttpClient = (options: PartyRegistryHttpClientOptions = {}) =>
  makeEffectBffClient({
    api: partyRegistryApi,
    defaultApiPrefix: partyRegistryApiContract.apiPrefix,
    ...effectBffClientOptions(partyRegistryHttpRequestContext(options)),
  });
