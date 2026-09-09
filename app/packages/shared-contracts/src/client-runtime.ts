import { Effect, Schema, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type { EffectHttpApiClientOptions, HttpApi, HttpApiGroup } from '@modern-js/plugin-bff/effect-client';
import { Redacted } from 'effect';
import { Headers as HttpHeaders, HttpClient, HttpClientRequest } from 'effect/unstable/http';

const EffectBffOperationContextSchema = Schema.Struct({
  method: Schema.String,
  // eslint-disable-next-line effect-native/no-unbranded-identifier-schema -- The framework operation name is owner-supplied routing metadata, not an interchangeable Resource identifier.
  operationId: Schema.String,
  routePath: Schema.String,
  source: Schema.Literals(['client', 'server', 'generated-client', 'effect-adapter', 'data-platform', 'unknown']),
});

export type EffectBffOperationContext = typeof EffectBffOperationContextSchema.Type;

export interface EffectBffRequestContext {
  readonly locale?: string;
  readonly operationContext?: EffectBffOperationContext;
  // eslint-disable-next-line effect-native/no-threaded-correlation-parameter -- #358 requires this browser client seam to accept and propagate the standard W3C transport field.
  readonly traceparent?: string;
}

export interface EffectBffClientOptions {
  readonly baseUrl?: string | URL;
  readonly requestContext?: EffectBffRequestContext;
  readonly transportHeaders?: HttpHeaders.Input;
}

export interface EffectBffClientConfig<
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
> extends EffectBffClientOptions {
  readonly api: HttpApi.HttpApi<ApiId, Groups>;
  readonly defaultApiPrefix: string | URL;
}

const encodeOperationContext = Schema.encodeResult(Schema.fromJsonString(EffectBffOperationContextSchema));

export const makeEffectBffClient = <ApiId extends string, Groups extends HttpApiGroup.Constraint>({
  api,
  baseUrl,
  defaultApiPrefix,
  requestContext,
  transportHeaders,
}: EffectBffClientConfig<ApiId, Groups>) => {
  const { operationContext } = requestContext ?? {};
  const resolvedTransportHeaders = HttpHeaders.fromInput(transportHeaders);
  const makeClient = (operationContextText: string | null) => {
    const clientOptions: EffectHttpApiClientOptions = {
      baseUrl: baseUrl ?? defaultApiPrefix,
      transformClient: (client) => {
        const transformedClient = client.pipe(
          HttpClient.mapRequest((request) => {
            let nextRequest = request;
            if (operationContext !== undefined && operationContextText !== null) {
              nextRequest = HttpClientRequest.setHeader(
                nextRequest,
                'x-modernjs-bff-operation-context',
                operationContextText,
              );
              const { operationId } = operationContext;
              nextRequest = HttpClientRequest.setHeader(nextRequest, 'x-operation-id', operationId);
            }
            return HttpClientRequest.setHeaders(nextRequest, resolvedTransportHeaders);
          }),
        );
        // Effect injects fresh trace headers after request transforms. This boundary instead makes
        // the caller's request context authoritative so explicit traceparent values survive and
        // absent optional tracing metadata stays absent.
        return transformedClient.pipe(
          HttpClient.transform((effect) => Effect.provideService(effect, HttpClient.TracerPropagationEnabled, false)),
        );
      },
    };
    if (requestContext !== undefined) {
      clientOptions.requestContext = requestContext;
    }
    // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- #358 explicitly requires lazy uncached client construction so request metadata and credentials cannot survive across operations. expires: 2026-12-31.
    return makeEffectHttpApiClient(api, clientOptions);
  };
  const operationContextText: Effect.Effect<string | null, Schema.SchemaError> =
    operationContext === undefined ? Effect.succeed(null) : Effect.fromResult(encodeOperationContext(operationContext));
  return operationContextText.pipe(Effect.flatMap(makeClient));
};

interface GovernedEffectBffClientConfig<ApiId extends string, Groups extends HttpApiGroup.Constraint> {
  readonly api: HttpApi.HttpApi<ApiId, Groups>;
  readonly credential: Redacted.Redacted;
  readonly defaultApiPrefix: string | URL;
  readonly requestCorrelation: string;
}

const isGovernedBaseUrl = (value: string): boolean => {
  const url = URL.parse(value, 'https://relative-owner.invalid');
  return (
    value.trim() === value &&
    !value.includes('\\') &&
    !value.startsWith('//') &&
    (value.startsWith('/') || /^https?:\/\//u.test(value)) &&
    url !== null &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === ''
  );
};

/** Fresh per-invocation transport; credentials remain redacted until HTTP header construction. */
export const makeGovernedEffectBffClient = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  { api, credential, defaultApiPrefix, requestCorrelation }: GovernedEffectBffClientConfig<ApiId, Groups>,
  options: Pick<EffectBffClientOptions, 'baseUrl'>,
) => {
  const baseUrl = String(options.baseUrl ?? defaultApiPrefix);
  const clientConfig = {
    api,
    baseUrl,
    defaultApiPrefix,
    transportHeaders: {
      authorization: Redacted.value(credential),
      'x-correlation-id': requestCorrelation,
    },
  };
  return Schema.decodeUnknownEffect(Schema.Literal(true))(isGovernedBaseUrl(baseUrl)).pipe(
    Effect.map(() => clientConfig),
    Effect.flatMap(makeEffectBffClient),
  );
};
