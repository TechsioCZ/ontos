import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { Effect, Exit, Predicate, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpServerResponse } from 'effect/http';

export const CIMD_FETCH_TIMEOUT_MS = 5000;
export const CIMD_MAX_RESPONSE_BYTES = 5 * 1024;
const SET_COOKIE_HEADER = 'set-cookie';

export class CimdFetchError extends Schema.TaggedError<CimdFetchError>()('CimdFetchError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

const transportFailure = (cause: unknown) =>
  new CimdFetchError({
    cause,
    message: Predicate.isError(cause) ? cause.message : 'CIMD resource request failed',
  });

const isPublicHttpsUrl = (url: URL): boolean => {
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    hostname !== 'localhost' &&
    !hostname.endsWith('.localhost') &&
    !hostname.endsWith('.local') &&
    !hostname.includes(':') &&
    !/^[\d.]+$/u.test(hostname)
  );
};

const cancelResponseBody = Effect.fn('Cimd.cancelResponseBody')((response: Response) =>
  response.body === null
    ? Effect.void
    : Effect.tryPromise({
        catch: transportFailure,
        try: response.body.cancel.bind(response.body),
      }).pipe(Effect.timeout('1 second')),
);

const rejectResponse = Effect.fn('Cimd.rejectResponse')((response: Response, message: string) =>
  cancelResponseBody(response).pipe(Effect.andThen(Effect.fail(new CimdFetchError({ message })))),
);

const readResponseBytes = Effect.fn('Cimd.readResponseBytes')(function* readBytes(response: Response) {
  if (response.body === null) {
    return new Uint8Array();
  }
  const { body } = response;
  const bytes = new Uint8Array(CIMD_MAX_RESPONSE_BYTES);
  const size = yield* Stream.fromReadableStream({
    evaluate: () => body,
    onError: transportFailure,
    releaseLockOnEnd: true,
  }).pipe(
    Stream.runFoldEffect(
      () => 0,
      (offset, chunk) =>
        Effect.suspend(() => {
          const nextOffset = offset + chunk.byteLength;
          if (nextOffset > CIMD_MAX_RESPONSE_BYTES) {
            return Effect.fail(new CimdFetchError({ message: 'CIMD resource is too large' }));
          }
          bytes.set(chunk, offset);
          return Effect.succeed(nextOffset);
        }),
    ),
    Effect.onExit((exit) => (Exit.isFailure(exit) ? cancelResponseBody(response) : Effect.void)),
  );
  return bytes.slice(0, size);
});

/**
 * Workers own DNS and public-network routing; Fetch cannot inspect or pin a resolved address.
 * Never bind this transport to private services, VPC, or a resolveOverride. The Better Auth SDK
 * callback runs this operation through the serving request's Effect context.
 */
export const fetchClientMetadataResource = Effect.fn('Cimd.fetchClientMetadataResource')(
  function* fetchMetadata(
    input: Parameters<ClientMetadataResourceFetch>[0],
    init?: Parameters<ClientMetadataResourceFetch>[1],
  ) {
    // workerd supports only follow/manual redirects. Refuse redirected responses explicitly below.
    const { redirect: _redirect, ...requestInit } = init ?? {};
    const request = yield* Effect.try({
      catch: transportFailure,
      try: () => new Request(input, requestInit),
    });
    if (!isPublicHttpsUrl(new URL(request.url))) {
      return yield* new CimdFetchError({ message: 'CIMD requires a public HTTPS hostname' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return yield* new CimdFetchError({ message: 'CIMD supports only GET and HEAD' });
    }
    const scopeSignal = yield* Effect.abortSignal;
    const signal = AbortSignal.any([request.signal, scopeSignal]);
    const fetch = yield* FetchHttpClient.Fetch;
    const response = yield* Effect.tryPromise({
      catch: transportFailure,
      try: fetch.bind(globalThis, request, { redirect: 'manual', signal }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CIMD_FETCH_TIMEOUT_MS,
        orElse: () => Effect.fail(new CimdFetchError({ message: 'CIMD fetch timed out' })),
      }),
    );
    if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
      return yield* rejectResponse(response, 'CIMD redirects are forbidden');
    }
    // The resolver joins conditional 304s with its validated cache entry.
    if (response.status === 304 || request.method === 'HEAD') {
      yield* cancelResponseBody(response);
      const headers = new Headers(response.headers);
      const adapted = HttpServerResponse.empty({
        headers,
        status: response.status,
        statusText: response.statusText,
      }).pipe(HttpServerResponse.toWeb);
      adapted.headers.delete(SET_COOKIE_HEADER);
      for (const cookie of headers.getSetCookie()) {
        adapted.headers.append(SET_COOKIE_HEADER, cookie);
      }
      return adapted;
    }
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/iu.test(response.headers.get('content-type') ?? '')) {
      return yield* rejectResponse(response, 'CIMD resource must be JSON');
    }
    if (Number(response.headers.get('content-length')) > CIMD_MAX_RESPONSE_BYTES) {
      return yield* rejectResponse(response, 'CIMD resource is too large');
    }
    const bytes = yield* readResponseBytes(response);
    yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(bytes));
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const adapted = HttpServerResponse.raw(bytes, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }).pipe(HttpServerResponse.toWeb);
    adapted.headers.delete(SET_COOKIE_HEADER);
    for (const cookie of headers.getSetCookie()) {
      adapted.headers.append(SET_COOKIE_HEADER, cookie);
    }
    return adapted;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: CIMD_FETCH_TIMEOUT_MS,
    orElse: () => Effect.fail(new CimdFetchError({ message: 'CIMD fetch timed out' })),
  }),
);
