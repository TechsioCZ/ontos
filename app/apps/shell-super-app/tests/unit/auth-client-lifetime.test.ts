import { expect, test } from '@rstest/core';
import { Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { ShellAuthenticationApi } from '../../shared/api.ts';

interface RecordedRequest {
  readonly cookie: string;
  readonly locale: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred. `HttpApiClient` reflects the API — reading `groups` exactly
 * once — for every client it builds, so this getter counts builds directly. Installed before the
 * client module is imported, which is why that module is reached through `import()` below.
 */
let apiReflections = 0;
const authenticationGroups = ShellAuthenticationApi.groups;
Object.defineProperty(ShellAuthenticationApi, 'groups', {
  configurable: true,
  get: () => {
    apiReflections += 1;
    return authenticationGroups;
  },
});

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      cookie: headers.get('cookie') ?? '',
      locale: headers.get('accept-language') ?? '',
      url: new Request(input).url,
    });
    // The smallest decodable success, so every call completes and only the request is under test.
    return Response.json({ tenants: [] });
  };

const byCookie = (left: RecordedRequest, right: RecordedRequest) =>
  left.cookie.localeCompare(right.cookie);

const tenantsPath = '/shell-super-app-api/auth/tenants';

/**
 * One test, because every claim reads the same piece of process state: this module owns exactly one
 * typed client for the life of the process.
 *
 * Reuse is proved by the build counter, never by transport inheritance. Inheritance is the bug this
 * test exists to reject: a client built inside its first caller keeps that caller's context — its
 * `FetchHttpClient.Fetch` above all — merged under every later request, so a later call that injects
 * nothing would silently ride the first caller's transport, and with it that caller's session
 * cookie. A shared client must retain nothing: a call that injects a transport gets exactly that
 * one, a call that injects none falls through to the ordinary default, and each call's base URL,
 * cookie and locale reach only its own request.
 */
test('builds the Shell authentication client once while retaining nothing from any caller', async () => {
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];
  const interleaved = [
    { baseUrl: 'https://a.example/shell-super-app-api', cookie: 'session=a', locale: 'en-GB' },
    { baseUrl: 'https://b.example/shell-super-app-api', cookie: 'session=b', locale: 'fr-FR' },
    { baseUrl: 'https://c.example/shell-super-app-api', cookie: 'session=c', locale: 'de-DE' },
  ] as const;

  globalThis.fetch = recorder(ambient);
  let reflectionsBeforeAnyCall = 0;
  try {
    const { availableTenants } = await import('../../src/api/auth-client.ts');
    reflectionsBeforeAnyCall = apiReflections;

    await Effect.runPromise(
      // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
      availableTenants({
        baseUrl: 'https://first.example/shell-super-app-api',
        cookie: 'session=first',
        locale: 'en-US',
      }).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
        // Injects nothing: it must reach the ambient default, never the first call's recorder.
        Effect.andThen(
          availableTenants({
            baseUrl: 'https://second.example/shell-super-app-api',
            cookie: 'session=second',
          }).pipe(Effect.result),
        ),
        Effect.andThen(
          Effect.all(
            interleaved.map((call) => availableTenants(call).pipe(Effect.result)),
            { concurrency: 'unbounded' },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
        ),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Reuse: five requests, one client, built before any call runs and never rebuilt, so no call can
  // be the one whose context a later call inherits.
  expect(reflectionsBeforeAnyCall).toBe(1);
  expect(apiReflections).toBe(1);

  // No inheritance: the injecting call took its own transport and only its own request.
  expect(injectedFirst).toEqual([
    { cookie: 'session=first', locale: 'en-US', url: `https://first.example${tenantsPath}` },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  // No locale was asked for, so no `accept-language` is invented for it.
  expect(ambient).toEqual([
    { cookie: 'session=second', locale: '', url: `https://second.example${tenantsPath}` },
  ]);

  // Per-call injection wins on that same shared client, and three concurrent calls each keep their
  // own base URL, their own credential and their own locale.
  expect(injectedLater.toSorted(byCookie)).toEqual([
    { cookie: 'session=a', locale: 'en-GB', url: `https://a.example${tenantsPath}` },
    { cookie: 'session=b', locale: 'fr-FR', url: `https://b.example${tenantsPath}` },
    { cookie: 'session=c', locale: 'de-DE', url: `https://c.example${tenantsPath}` },
  ]);
});

/**
 * A budget is only a deadline if it ends the request as well as the Effect. A timeout that returned
 * while the socket stayed open would leak the connection and, on a write, leave the caller unable to
 * tell an abandoned attempt from a rejected one.
 */
test('bounds a stalled call with a typed TimeoutError, aborting it and never retrying', async () => {
  let attempts = 0;
  let aborted = false;

  const { availableTenants } = await import('../../src/api/auth-client.ts');
  const result = await Effect.runPromise(
    availableTenants({
      baseUrl: 'https://slow.example/shell-super-app-api',
      cookie: 'session=slow',
      timeoutMs: 25,
    }).pipe(
      Effect.result,
      Effect.provideService(FetchHttpClient.Fetch, async (_input, init) => {
        attempts += 1;
        // Settles only on abort: nothing but the deadline can end this call.
        const connection = Promise.withResolvers<Response>();
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            connection.reject(new Error('aborted'));
          },
          { once: true },
        );
        return await connection.promise;
      }),
    ),
  );

  // The deadline is a typed failure, not a defect, and it fired once: expiry interrupts this call
  // rather than re-issuing it, so a timed-out write is left unknown rather than replayed.
  expect(Result.isFailure(result) ? result.failure._tag : 'Success').toBe('TimeoutError');
  expect(aborted).toBe(true);
  expect(attempts).toBe(1);
  // The budget is per call, so it cannot have rebuilt the process-wide client.
  expect(apiReflections).toBe(1);
});
