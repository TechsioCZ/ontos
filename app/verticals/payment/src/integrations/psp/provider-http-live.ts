import { Cause, Effect, Layer, Match, Option, Schedule, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import type { HttpClientError, HttpClientRequest } from 'effect/http';
import type { Duration } from 'effect';

import { ProviderHttp, ProviderHttpResponseSchema } from './provider-http.ts';
import type { ProviderHttpContract, ProviderHttpReadRequest, ProviderHttpResponse } from './provider-http.ts';
import { GatewayProviderOutcomeUnknown, GatewayProviderUnavailable } from './psp-errors.ts';
import type { GatewayProviderOutcomeUnknownError, GatewayProviderUnavailableError } from './psp-errors.ts';

/**
 * Live `ProviderHttp` (#1158) on the Effect `HttpClient`. It replaces the donor HTTP client, which
 * retried POST/PUT/PATCH/DELETE: reads retry within a small bound, mutations are sent exactly once.
 * Nothing here logs or puts a body, header, URL or secret into an error: failures carry only a fixed
 * reason code.
 */

const READ_ATTEMPT_TIMEOUT = '10 seconds';
const READ_RETRIES = 2;
const READ_BACKOFF = Schedule.exponential('200 millis');
const MUTATION_TIMEOUT = '20 seconds';

const REASON_PRE_SEND = 'provider_request_not_sent';
const REASON_TRANSPORT = 'provider_transport_failed';
const REASON_TIMEOUT = 'provider_attempt_timed_out';
const REASON_THROTTLED = 'provider_throttled';
const REASON_SERVER_ERROR = 'provider_server_error';
const REASON_STATUS_INVALID = 'provider_status_out_of_range';

/** Read failures that may succeed on another attempt. A request that cannot be built is final. */
const RETRYABLE_READ_REASONS: ReadonlySet<string> = new Set([
  REASON_SERVER_ERROR,
  REASON_STATUS_INVALID,
  REASON_THROTTLED,
  REASON_TIMEOUT,
  REASON_TRANSPORT,
]);

/**
 * Socket error codes raised while resolving or connecting, before any request byte is written. Any
 * other transport failure (reset, hang-up, TLS or protocol failure, unknown cause) may follow the
 * write, so a mutation that hits it is OUTCOME_UNKNOWN.
 */
const PreWriteSocketCodeSchema = Schema.Literals([
  'EAI_AGAIN',
  'EAI_NODATA',
  'EAI_NONAME',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const PreWriteSocketErrorSchema = Schema.Struct({ code: PreWriteSocketCodeSchema });
/** A Node socket error itself, or `fetch`'s `TypeError('fetch failed')` wrapping it. */
const PreWriteTransportCauseSchema = Schema.Union([
  PreWriteSocketErrorSchema,
  Schema.Struct({ cause: PreWriteSocketErrorSchema }),
]);
const isPreWriteTransportCause = Schema.is(PreWriteTransportCauseSchema);

/** The provider cannot have seen this attempt: it was never built, or the connection never opened. */
const attemptNotSent = (error: HttpClientError.HttpClientError): boolean =>
  Match.value(error.reason).pipe(
    Match.tag('EncodeError', 'InvalidUrlError', () => true),
    Match.tag('TransportError', ({ cause }) => isPreWriteTransportCause(cause)),
    Match.orElse(() => false),
  );

/** A read that could not even be built is final; any transport or body failure may pass on retry. */
const readFailureReason = (error: HttpClientError.HttpClientError): string =>
  Match.value(error.reason).pipe(
    Match.tag('EncodeError', 'InvalidUrlError', () => REASON_PRE_SEND),
    Match.orElse(() => REASON_TRANSPORT),
  );

const toProviderResponse = (status: number, bodyText: string): Option.Option<ProviderHttpResponse> =>
  Schema.decodeUnknownOption(ProviderHttpResponseSchema)({ bodyText, status });

/** One attempt; the timeout covers the whole exchange including the body read. */
const sendBuffered = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  timeout: Duration.Input,
): Effect.Effect<Option.Option<ProviderHttpResponse>, HttpClientError.HttpClientError | Cause.TimeoutError> =>
  client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(Effect.map((bodyText) => toProviderResponse(response.status, bodyText))),
    ),
    Effect.timeout(timeout),
  );

const isServerError = (status: number): boolean => status >= 500;

const makeProviderHttp = Effect.gen(function* makeProviderHttpEffect() {
  const client = yield* HttpClient.HttpClient;

  const readAttempt = ({
    family,
    request,
  }: ProviderHttpReadRequest): Effect.Effect<ProviderHttpResponse, GatewayProviderUnavailableError> => {
    const unavailable = (reason: string) =>
      new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });
    return sendBuffered(client, request, READ_ATTEMPT_TIMEOUT).pipe(
      Effect.mapError((failure) =>
        unavailable(Cause.isTimeoutError(failure) ? REASON_TIMEOUT : readFailureReason(failure)),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(unavailable(REASON_STATUS_INVALID)),
          onSome: (response) => {
            if (response.status === 429) {
              return Effect.fail(unavailable(REASON_THROTTLED));
            }
            return isServerError(response.status)
              ? Effect.fail(unavailable(REASON_SERVER_ERROR))
              : Effect.succeed(response);
          },
        }),
      ),
    );
  };

  return {
    mutate: ({ family, operationId, request }) => {
      const outcomeUnknown = (reason: string): GatewayProviderOutcomeUnknownError =>
        new GatewayProviderOutcomeUnknown({ code: 'gateway_provider_outcome_unknown', family, operationId, reason });
      const notSent = (): GatewayProviderUnavailableError =>
        new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason: REASON_PRE_SEND });
      return sendBuffered(client, request, MUTATION_TIMEOUT).pipe(
        Effect.mapError((failure) => {
          if (Cause.isTimeoutError(failure)) {
            return outcomeUnknown(REASON_TIMEOUT);
          }
          return attemptNotSent(failure) ? notSent() : outcomeUnknown(REASON_TRANSPORT);
        }),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(outcomeUnknown(REASON_STATUS_INVALID)),
            onSome: (response) =>
              isServerError(response.status)
                ? Effect.fail(outcomeUnknown(REASON_SERVER_ERROR))
                : Effect.succeed(response),
          }),
        ),
      );
    },
    read: (input) =>
      readAttempt(input).pipe(
        Effect.retry({
          schedule: READ_BACKOFF,
          times: READ_RETRIES,
          while: (failure) => RETRYABLE_READ_REASONS.has(failure.reason),
        }),
      ),
  } satisfies ProviderHttpContract;
});

/**
 * Requires the deployment `HttpClient`, which must not retry, follow redirects, log, or propagate
 * trace headers to providers (the composition root disables its client span).
 */
export const ProviderHttpLive = Layer.effect(ProviderHttp, makeProviderHttp);
