import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type { HttpApi, HttpApiClient, HttpApiGroup } from '@modern-js/plugin-bff/effect-client';
import { Context, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { partyRegistryApi, partyRegistryApiContract } from '../../shared/api.ts';
import type { OperationContext } from '../../shared/api.ts';

type PartyRegistryApiGroups =
  typeof partyRegistryApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type PartyRegistryHttpClient = HttpApiClient.Client<
  Extract<PartyRegistryApiGroups, HttpApiGroup.Constraint>
>;

export const traceparentOption = 'traceparent' as const;
const requestCorrelationHeaderName = 'x-correlation-id' as const;

export interface PartyRegistryHttpClientOptions {
  readonly baseUrl?: string | URL;
  readonly locale?: string;
  readonly operationContext?: OperationContext;
  readonly [traceparentOption]?: string;
}

export type PartyRegistryAuthorizedInvocation<Options> = readonly [
  credential: string,
  requestCorrelation: string,
  options?: Options,
];

export type PartyRegistryOperationInvocation<Options> = readonly [
  requestCorrelation: string,
  options?: Options,
];

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

const defaultPartyRegistryHttpRequestContext: PartyRegistryHttpRequestContextValue = {
  baseUrl: partyRegistryApiContract.apiPrefix,
};

const PartyRegistryHttpRequestContext = Context.Reference<PartyRegistryHttpRequestContextValue>(
  'PartyRegistryHttpRequestContext',
  { defaultValue: () => defaultPartyRegistryHttpRequestContext },
);

const applyPartyRegistryHttpRequestContext = Effect.fn(
  'PartyRegistryHttpClient.applyRequestContext',
)(function* applyRequestContext(request: HttpClientRequest.HttpClientRequest) {
  const context = yield* PartyRegistryHttpRequestContext;
  let nextRequest = HttpClientRequest.prependUrl(request, context.baseUrl.toString());
  if (context.requestLocale !== undefined) {
    nextRequest = HttpClientRequest.setHeader(
      nextRequest,
      'accept-language',
      context.requestLocale,
    );
  }
  if (context.requestTraceparent !== undefined) {
    nextRequest = HttpClientRequest.setHeader(
      nextRequest,
      'traceparent',
      context.requestTraceparent,
    );
  }
  if (context.credential === undefined || context.requestCorrelation === undefined) {
    return nextRequest;
  }
  const requestCorrelationHeader = context.requestCorrelationHeader ?? 'x-correlation-id';
  return HttpClientRequest.setHeaders(
    nextRequest,
    context.requestTrace === undefined
      ? {
          authorization: Redacted.value(context.credential),
          [requestCorrelationHeader]: context.requestCorrelation,
        }
      : {
          authorization: Redacted.value(context.credential),
          [requestCorrelationHeader]: context.requestCorrelation,
          'x-trace-id': context.requestTrace,
        },
  );
});

const sharedPartyRegistryHttpClient = Effect.runSync(
  Effect.cached(
    makeEffectHttpApiClient(partyRegistryApi, {
      transformClient: HttpClient.mapRequestEffect(applyPartyRegistryHttpRequestContext),
    }),
  ),
);

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

export const invokePartyRegistryHttpClient = <Success, Failure, Requirements>(
  context: PartyRegistryHttpRequestContextValue,
  operation: (client: PartyRegistryHttpClient) => Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure, Requirements> =>
  sharedPartyRegistryHttpClient.pipe(
    Effect.flatMap(operation),
    Effect.provideService(PartyRegistryHttpRequestContext, context),
  );

type BindablePartyRegistryOperation = (
  ...arguments_: readonly unknown[]
) => Effect.Effect<unknown, object, object>;

type BindablePartyRegistryGroup = Readonly<
  Record<PropertyKey, BindablePartyRegistryOperation | undefined>
>;

type BindablePartyRegistryClient = Readonly<
  Record<PropertyKey, BindablePartyRegistryGroup | undefined>
>;

const bindPartyRegistryGroup = (
  group: BindablePartyRegistryGroup,
  context: PartyRegistryHttpRequestContextValue,
) =>
  new Proxy(group, {
    get(currentGroup, property) {
      const operation = currentGroup[property];
      if (operation === undefined) {
        return;
      }
      return (...args: readonly unknown[]) =>
        Effect.provideService(
          operation.bind(currentGroup)(...args),
          PartyRegistryHttpRequestContext,
          context,
        );
    },
  });

export const bindPartyRegistryHttpClient = (
  client: PartyRegistryHttpClient,
  context: PartyRegistryHttpRequestContextValue,
): PartyRegistryHttpClient => {
  // SAFETY: HttpApi clients contain named groups whose properties are endpoint functions. The
  // proxies retain that generated shape and only install the fiber-local request context.
  const bindableClient: BindablePartyRegistryClient = client as never;
  const boundClient = new Proxy(bindableClient, {
    get(currentClient, property) {
      const group = currentClient[property];
      return group === undefined ? undefined : bindPartyRegistryGroup(group, context);
    },
  });
  // SAFETY: The proxy above preserves the generated client shape described by the same contract.
  return boundClient as never;
};

export const createPartyRegistryHttpClient = (options: PartyRegistryHttpClientOptions = {}) =>
  sharedPartyRegistryHttpClient.pipe(
    Effect.map((client) =>
      bindPartyRegistryHttpClient(client, partyRegistryHttpRequestContext(options)),
    ),
  );
