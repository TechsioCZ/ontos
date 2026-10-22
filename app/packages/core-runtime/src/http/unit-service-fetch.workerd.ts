// @effect-diagnostics asyncFunction:off globalFetch:off -- Native Worker transport boundary: unit fetchers implement `typeof fetch`, and approved releases preserve the original streaming Response. remove-when: Effect exposes a native fetch transport preserving these contracts.
import { env } from 'cloudflare:workers';
import { Duration, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { ApplicationCompositionBackendSchema } from '../modules/application-composition-backend.ts';
import type { ApplicationCompositionBackend } from '../modules/application-composition-backend.ts';
import type { ApplicationCompositionModule } from '../modules/application-composition.ts';
import { moduleReleaseServiceBinding, moduleReleaseWorkerName } from './module-release-identity.ts';
import { ModuleReleaseTransportError } from './module-release-transport-error.ts';
import type { ModuleReleaseFetch } from './unit-service-fetch.ts';

/**
 * A Worker reaches an approved Worker release through the service binding its deployment declared for
 * that exact release: the release then runs on this machine, without a public round trip and a cold
 * isolate somewhere else. Without one it reaches the release's HTTPS origin.
 */
const releaseFetch = Effect.fn('ModuleRelease.selectWorkerTransport')(function* selectReleaseTransport(
  backend: ApplicationCompositionBackend,
) {
  if (backend.transport === 'cloudflare-worker') {
    const binding = env[moduleReleaseServiceBinding(backend.workerName)];
    const bindingFetch = binding?.fetch;
    if (bindingFetch !== undefined) {
      return bindingFetch.bind(binding);
    }
  }
  return yield* FetchHttpClient.Fetch;
});

/** Reaches only the independently executing release approved in the complete composition. */
export const moduleReleaseFetch: ModuleReleaseFetch = Effect.fn('ModuleRelease.fetchWorker')(
  function* fetchWorkerRelease(request: Request, module: ApplicationCompositionModule) {
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
    const fetch = yield* releaseFetch(backend);
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
  },
);
