import { fromReadable, toReadable } from '@effect/platform-node/NodeStream';
import { request as requestNodeHttp } from '@effect/platform-node/Undici';
import { Duration, Effect, Schema, Stream } from 'effect';

import { ApplicationCompositionBackendSchema } from '../modules/application-composition-backend.ts';
import type { ApplicationCompositionModule } from '../modules/application-composition.ts';
import { moduleReleaseWorkerName } from './module-release-identity.ts';
import { ModuleReleaseTransportError } from './module-release-transport-error.ts';
import type { UnitRoutedFetch, UnitServiceFetch } from './unit-service-fetch.ts';

/** Node reaches every unit at its configured URL. */
export const unitServiceFetch: UnitServiceFetch = () => globalThis.fetch;

export const unitRoutedFetch: UnitRoutedFetch = () => globalThis.fetch;

/** Node sends bytes to an independently executing, explicitly approved owner release. */
export const moduleReleaseFetch = Effect.fn('ModuleRelease.fetchNode')(function* fetchNodeRelease(
  request: Request,
  module: ApplicationCompositionModule,
) {
  const backend = yield* Schema.decodeEffect(ApplicationCompositionBackendSchema)(module.backend).pipe(
    Effect.mapError(
      (cause) => new ModuleReleaseTransportError({ cause, reason: 'The approved owner placement is invalid' }),
    ),
  );
  if (backend.transport === 'cloudflare-worker') {
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    if (backend.workerName !== workerName) {
      return yield* new ModuleReleaseTransportError({ reason: 'The approved native executable identity is invalid' });
    }
  }
  const requestedUrl = new URL(request.url);
  const ownerUrl = new URL(backend.baseUrl);
  ownerUrl.pathname = requestedUrl.pathname;
  ownerUrl.search = requestedUrl.search;
  const requestBody = request.body;
  const body =
    requestBody === null
      ? null
      : yield* toReadable(
          Stream.fromReadableStream({
            evaluate: () => requestBody,
            onError: (cause) => new ModuleReleaseTransportError({ cause, reason: 'The owner request body failed' }),
          }),
        );
  const response = yield* Effect.tryPromise({
    catch: (cause) =>
      new ModuleReleaseTransportError({ cause, reason: 'The approved independent owner release is unavailable' }),
    try: (signal): PromiseLike<Awaited<ReturnType<typeof requestNodeHttp>>> =>
      requestNodeHttp(ownerUrl, {
        body,
        bodyTimeout: 0,
        headers: Object.fromEntries(request.headers),
        headersTimeout: 30_000,
        method: request.method,
        signal: AbortSignal.any([signal, request.signal]),
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.fail(new ModuleReleaseTransportError({ reason: 'The approved owner response timed out' })),
    }),
  );
  const headers = new Headers();
  for (const [name, values] of Object.entries(response.headers)) {
    if (Array.isArray(values)) {
      for (const value of values) {
        headers.append(name, value);
      }
    } else if (values !== undefined) {
      headers.append(name, values);
    }
  }
  const hasNoBody = request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
  if (hasNoBody) {
    response.body.resume();
  }
  const responseBody = hasNoBody
    ? null
    : Stream.toReadableStream(
        fromReadable<Uint8Array, ModuleReleaseTransportError>({
          evaluate: () => response.body,
          onError: (cause) => new ModuleReleaseTransportError({ cause, reason: 'The owner response body failed' }),
        }),
      );
  return new Response(responseBody, {
    headers,
    status: response.statusCode,
    statusText: response.statusText,
  });
});
