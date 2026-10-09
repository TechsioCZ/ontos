// @effect-diagnostics asyncFunction:off globalFetch:off -- Native Worker transport boundary: unit fetchers implement `typeof fetch`, and approved releases preserve the original streaming Response. remove-when: Effect exposes a native fetch transport preserving these contracts.
import { env } from 'cloudflare:workers';
import { Data, Duration, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { ApplicationCompositionBackendSchema } from '../modules/application-composition-backend.ts';
import type { ApplicationCompositionModule } from '../modules/application-composition.ts';
import { moduleReleaseWorkerName } from './module-release-identity.ts';
import { ModuleReleaseTransportError } from './module-release-transport-error.ts';
import type { UnitRoute, UnitRoutedFetch, UnitServiceFetch } from './unit-service-fetch.ts';

class UnitServiceBindingMissingError extends Data.TaggedError('UnitServiceBindingMissingError')<{
  readonly serviceBinding: string;
}> {}

/**
 * A Worker reaches another unit only through its service binding; the request keeps its URL path
 * and the binding ignores the host. A missing binding rejects like an unreachable service.
 */
export const unitServiceFetch: UnitServiceFetch = (serviceBinding) => {
  const binding = env[serviceBinding];
  const bindingFetch = binding?.fetch;
  if (bindingFetch === undefined) {
    return async () => {
      throw new UnitServiceBindingMissingError({ serviceBinding });
    };
  }
  return bindingFetch.bind(binding);
};

const routeFor = (routes: readonly UnitRoute[], url: URL): UnitRoute | undefined =>
  routes.find(
    ({ baseUrl }) =>
      url.origin === baseUrl.origin &&
      (url.pathname === baseUrl.pathname ||
        url.pathname.startsWith(baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`)),
  );

export const unitRoutedFetch: UnitRoutedFetch = (routes) => async (input, init) => {
  const request = new Request(input, init);
  const route = routeFor(routes, new URL(request.url));
  return await (route === undefined ? globalThis.fetch(request) : unitServiceFetch(route.serviceBinding)(request));
};

/** Native HTTPS reaches only the independently executing origin approved in the complete composition. */
export const moduleReleaseFetch = Effect.fn('ModuleRelease.fetchWorker')(function* fetchWorkerRelease(
  request: Request,
  module: ApplicationCompositionModule,
) {
  const backend = yield* Schema.decodeEffect(ApplicationCompositionBackendSchema)(module.backend).pipe(
    Effect.mapError(
      (cause) => new ModuleReleaseTransportError({ cause, reason: 'The approved owner placement is invalid' }),
    ),
  );
  const ownerUrl = new URL(backend.baseUrl);
  if (ownerUrl.protocol !== 'https:') {
    return yield* new ModuleReleaseTransportError({ reason: 'The approved Worker owner transport requires HTTPS' });
  }
  if (backend.transport === 'cloudflare-worker') {
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    if (backend.workerName !== workerName) {
      return yield* new ModuleReleaseTransportError({ reason: 'The approved native executable identity is invalid' });
    }
  }
  const requestedUrl = new URL(request.url);
  ownerUrl.pathname = requestedUrl.pathname;
  ownerUrl.search = requestedUrl.search;
  const fetch = yield* FetchHttpClient.Fetch;
  return yield* Effect.tryPromise({
    catch: (cause) =>
      new ModuleReleaseTransportError({ cause, reason: 'The approved native module executable is unavailable' }),
    try: (signal): PromiseLike<Response> =>
      fetch(
        new Request(ownerUrl, {
          body: request.body,
          headers: request.headers,
          method: request.method,
          redirect: 'manual',
          signal: AbortSignal.any([signal, request.signal]),
        }),
      ),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.fail(new ModuleReleaseTransportError({ reason: 'The approved owner response timed out' })),
    }),
  );
});
