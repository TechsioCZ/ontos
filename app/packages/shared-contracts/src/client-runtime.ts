import { Effect, Schema, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type { EffectHttpApiClientOptions, HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { Redacted } from 'effect';
import { Headers as HttpHeaders, HttpClient } from 'effect/http';

const EffectBffOperationContextSchema = Schema.Struct({
  method: Schema.String,
  // eslint-disable-next-line effect-native/no-unbranded-identifier-schema -- The framework operation name is owner-supplied routing metadata, not an interchangeable Resource identifier.
  operationId: Schema.String,
  routePath: Schema.String,
  source: Schema.Literals(['client', 'server', 'generated-client', 'effect-server', 'data-platform', 'unknown']),
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
  readonly compositionRevision?: string;
  readonly referenceCredentials?: Redacted.Redacted;
  readonly requestContext?: EffectBffRequestContext;
  /** Owner-resolved transport headers; undefined values stay absent on the wire. */
  readonly transportHeaders?: HttpHeaders.Input;
}

export interface EffectBffClientOptionsConfig extends EffectBffClientOptions {
  readonly defaultApiPrefix: string | URL;
}

const encodeOperationContext = Schema.encodeResult(Schema.fromJsonString(EffectBffOperationContextSchema));

// Effect injects fresh trace headers after request transforms. OntOS clients instead make the caller's
// request context authoritative, so explicit traceparent values survive and absent tracing stays absent.
const withCallerTraceContext = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.transform((effect) => Effect.provideService(effect, HttpClient.TracerPropagationEnabled, false)),
  );

/**
 * Options for the native `makeEffectHttpApiClient`: the owner prefix fallback, the governed operation
 * context and transport headers, and the caller's locale and traceparent. The operation context is sent
 * exactly as the Effect BFF server decodes it (`x-operation-id` plus the encoded
 * `x-modernjs-bff-operation-context`), and transport headers win over it, as before.
 */
export const makeEffectBffClientOptions = ({
  baseUrl,
  defaultApiPrefix,
  requestContext,
  transportHeaders,
}: EffectBffClientOptionsConfig): Effect.Effect<EffectHttpApiClientOptions, Schema.SchemaError> => {
  const { operationContext, ...callerContext } = requestContext ?? {};
  const operationContextText: Effect.Effect<string | null, Schema.SchemaError> =
    operationContext === undefined ? Effect.succeed(null) : Effect.fromResult(encodeOperationContext(operationContext));
  return operationContextText.pipe(
    Effect.map((encodedOperationContext) => {
      const operationHeaders =
        operationContext === undefined || encodedOperationContext === null
          ? {}
          : {
              'x-modernjs-bff-operation-context': encodedOperationContext,
              'x-operation-id': operationContext.operationId,
            };
      const options: EffectHttpApiClientOptions = {
        baseUrl: baseUrl ?? defaultApiPrefix,
        headers: { ...operationHeaders, ...HttpHeaders.fromInput(transportHeaders) },
        transformClient: withCallerTraceContext,
      };
      if (requestContext !== undefined) {
        options.requestContext = callerContext;
      }
      return options;
    }),
  );
};

interface GovernedEffectBffClientConfig<ApiId extends string, Groups extends HttpApiGroup.Constraint> {
  readonly api: HttpApi.HttpApi<ApiId, Groups>;
  readonly credential: Redacted.Redacted;
  readonly defaultApiPrefix: string | URL;
  /** Action transport header; endpoint contracts declare no header codec. */
  readonly idempotencyKey?: string | undefined;
  readonly requestCorrelation: string;
  readonly requestTrace?: string;
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
  {
    api,
    credential,
    defaultApiPrefix,
    idempotencyKey,
    requestCorrelation,
    requestTrace,
  }: GovernedEffectBffClientConfig<ApiId, Groups>,
  options: Pick<EffectBffClientOptions, 'baseUrl' | 'compositionRevision' | 'referenceCredentials'>,
) => {
  const baseUrl = String(options.baseUrl ?? defaultApiPrefix);
  // Header construction skips undefined values, so absent optional headers stay absent.
  const transportHeaders = {
    authorization: Redacted.value(credential),
    'idempotency-key': idempotencyKey,
    'x-correlation-id': requestCorrelation,
    'x-ontos-composition-revision': options.compositionRevision,
    'x-ontos-reference-credentials':
      options.referenceCredentials === undefined ? undefined : Redacted.value(options.referenceCredentials),
    'x-trace-id': requestTrace,
  };
  return Schema.decodeUnknownEffect(Schema.Literal(true))(isGovernedBaseUrl(baseUrl)).pipe(
    Effect.flatMap(() => makeEffectBffClientOptions({ baseUrl, defaultApiPrefix, transportHeaders })),
    // eslint-disable-next-line effect-native/no-per-operation-http-api-client -- #358 explicitly requires lazy uncached client construction so request metadata and credentials cannot survive across operations. expires: 2026-12-31.
    Effect.flatMap((clientOptions) => makeEffectHttpApiClient(api, clientOptions)),
  );
};
