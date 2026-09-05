// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { contactsApi } from '../../shared/api.ts';
import { OrganizationEngagementProfileApi } from '../../shared/apis/organization-engagement-profile.ts';
import { PersonEngagementProfileApi } from '../../shared/apis/person-engagement-profile.ts';
import type { OrganizationEngagementProfileRef } from '../../shared/resources/organization-engagement-profile.ts';
import type { PersonEngagementProfileRef } from '../../shared/resources/person-engagement-profile.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly locale: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred. `HttpApiClient` reflects the API — reading `groups` exactly
 * once — for every client it builds, so these getters count builds directly, independently of any
 * context a call happens to carry. Installed before the client modules are imported, which is why
 * those modules are reached through `import()` below rather than a hoisted `import`.
 */
const reflections = { contacts: 0, organization: 0, person: 0 };
const countGroups = <Groups>(
  api: { readonly groups: Groups },
  key: keyof typeof reflections,
): void => {
  const { groups } = api;
  Object.defineProperty(api, 'groups', {
    configurable: true,
    get: () => {
      reflections[key] += 1;
      return groups;
    },
  });
};
countGroups(contactsApi, 'contacts');
countGroups(OrganizationEngagementProfileApi, 'organization');
countGroups(PersonEngagementProfileApi, 'person');

const tenantId = '20000000-0000-4000-8000-000000000001';
const personRef: PersonEngagementProfileRef = {
  moduleId: 'contacts.core',
  resourceId: 'person-1',
  resourceType: 'contacts.core.person-engagement-profile',
  tenantId,
};
const organizationRef: OrganizationEngagementProfileRef = {
  moduleId: 'contacts.core',
  resourceId: 'organization-1',
  resourceType: 'contacts.core.organization-engagement-profile',
  tenantId,
};

/** Effect's fetch client passes an absolute URL; `Request` reads it back without stringifying. */
const urlOf = (input: RequestInfo | URL): string => new Request(input).url;

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      authorization: headers.get('authorization') ?? '',
      correlationId: headers.get('x-correlation-id') ?? '',
      locale: headers.get('accept-language') ?? '',
      url: urlOf(input),
    });
    // 503 completes each call without needing a decodable body; only the request is asserted here.
    return new Response(null, { status: 503 });
  };

const byCorrelationId = (left: RecordedRequest, right: RecordedRequest) =>
  left.correlationId.localeCompare(right.correlationId);

const withStubbedLocation = async <A>(body: () => Promise<A>): Promise<A> => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/contacts' },
  });
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
};

const contactsUrl = (origin: string, path: string) => `${origin}/contacts-api${path}`;

/**
 * One test, because every claim reads the same piece of process state: these three modules own
 * exactly one typed client each for the life of the process.
 *
 * Reuse is proved by the build counters, never by transport inheritance. Inheritance is the bug this
 * test exists to reject: a client built inside its first caller keeps that caller's context — its
 * `FetchHttpClient.Fetch` above all — merged under every later request, so a later call that injects
 * nothing would silently ride the first caller's transport.
 */
test('builds one Contacts client per API while retaining nothing from any caller', async () => {
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];

  const beforeAnyCall = await withStubbedLocation(async () => {
    globalThis.fetch = recorder(ambient);
    const { executeOrganizationEngagementProfileWithAuthorization } =
      await import('../../src/api/organization-engagement-profile-client.ts');
    const { executePersonEngagementProfileWithAuthorization, getContactsReadiness } =
      await import('../../src/api/contacts-client.ts');
    const counted = { ...reflections };

    await Effect.runPromise(
      // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
      executePersonEngagementProfileWithAuthorization(
        { profileRef: personRef },
        Redacted.make('Bearer first'),
        'correlation-first',
        {},
      ).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
        // Injects nothing: it must reach the ambient default, never the first call's recorder.
        Effect.andThen(
          executePersonEngagementProfileWithAuthorization(
            { profileRef: personRef },
            Redacted.make('Bearer second'),
            'correlation-second',
            {},
          ).pipe(Effect.result),
        ),
        Effect.andThen(
          Effect.all(
            [
              executePersonEngagementProfileWithAuthorization(
                { profileRef: personRef },
                Redacted.make('Bearer a'),
                'correlation-a',
                {},
              ).pipe(Effect.result),
              executeOrganizationEngagementProfileWithAuthorization(
                { profileRef: organizationRef },
                Redacted.make('Bearer b'),
                'correlation-b',
                { baseUrl: 'https://profiles.example/contacts-api' },
              ).pipe(Effect.result),
              // The aggregate client carries no credential and turns `locale` into `accept-language`,
              // which is the whole wire effect its `requestContext` option ever had.
              getContactsReadiness({
                baseUrl: 'https://readiness.example/contacts-api',
                locale: 'cs-CZ',
              }).pipe(Effect.result),
            ],
            { concurrency: 'unbounded' },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
        ),
      ),
    );

    return counted;
  });

  // Reuse: five requests, three clients. Each is built before any call runs and never rebuilt, so no
  // call can be the one whose context a later call inherits.
  assert.deepEqual(beforeAnyCall, { contacts: 1, organization: 1, person: 1 });
  assert.deepEqual(reflections, { contacts: 1, organization: 1, person: 1 });

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      locale: '',
      url: contactsUrl('https://shell.example', '/reads/person-engagement-profile'),
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      locale: '',
      url: contactsUrl('https://shell.example', '/reads/person-engagement-profile'),
    },
  ]);

  // Per-call injection wins on those same shared clients, and three concurrent calls each keep their
  // own base URL, credential and locale.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: '',
      correlationId: '',
      locale: 'cs-CZ',
      url: contactsUrl('https://readiness.example', '/contacts/readiness'),
    },
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      locale: '',
      url: contactsUrl('https://shell.example', '/reads/person-engagement-profile'),
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      locale: '',
      url: contactsUrl('https://profiles.example', '/reads/organization-engagement-profile'),
    },
  ]);
});

/**
 * The deadline is whole-operation: it must expire on a response whose headers already arrived and
 * whose body never finishes, which is exactly the case a connect-only timeout misses. Expiry is the
 * typed `TimeoutError`, and the attempt counter is what proves the module does not re-issue the
 * request — for a write, a deadline means an unknown commit, never something to retry here.
 */
test('expires the whole-operation deadline on a stalled body without a second attempt', async () => {
  const attempts: string[] = [];
  const aborts: string[] = [];

  const stalledBody: typeof globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    attempts.push(url);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"profileRef":'));
        init?.signal?.addEventListener('abort', () => {
          aborts.push(url);
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        });
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  };

  const outcome = await withStubbedLocation(async () => {
    const { executePersonEngagementProfileWithAuthorization } =
      await import('../../src/api/contacts-client.ts');
    return await Effect.runPromise(
      executePersonEngagementProfileWithAuthorization(
        { profileRef: personRef },
        Redacted.make('Bearer stalled'),
        'correlation-stalled',
        { timeoutMs: 25 },
      ).pipe(
        Effect.as('completed' as const),
        Effect.catchTag('TimeoutError', () => Effect.succeed('timed-out' as const)),
        Effect.catchCause(() => Effect.succeed('other-failure' as const)),
        Effect.provideService(FetchHttpClient.Fetch, stalledBody),
      ),
    );
  });

  assert.equal(outcome, 'timed-out');
  assert.equal(attempts.length, 1);
  assert.deepEqual(aborts, attempts);
});

interface StallRecorder {
  readonly aborts: string[];
  readonly attempts: string[];
  readonly fetch: typeof globalThis.fetch;
}

/** Headers arrive, the body never finishes: the stall a connect-only timeout misses. */
const stalledBodyRecorder = (): StallRecorder => {
  const aborts: string[] = [];
  const attempts: string[] = [];
  return {
    aborts,
    attempts,
    fetch: async (input, init) => {
      const url = urlOf(input);
      attempts.push(url);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          init?.signal?.addEventListener('abort', () => {
            aborts.push(url);
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    },
  };
};

/** No response at all. Settling on abort keeps no rejected promise of the test's own alive. */
const stalledFetchRecorder = (): StallRecorder => {
  const aborts: string[] = [];
  const attempts: string[] = [];
  return {
    aborts,
    attempts,
    fetch: async (input, init) => {
      const url = urlOf(input);
      attempts.push(url);
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => {
        aborts.push(url);
        pending.resolve(new Response(null, { status: 499 }));
      });
      return await pending.promise;
    },
  };
};

/**
 * The factory hands the client to a caller that runs its operations on a fiber of its own, so an
 * operation that is not already bound to the requested deadline has nowhere left to acquire one:
 * `options` is gone by then. Both stall shapes are asserted through the same returned operation,
 * because the leg being bounded is the request *and* its decode — and the attempt counter is what
 * proves expiry interrupts rather than re-issues.
 */
test(
  'binds the requested deadline to the operations createContactsClient returns',
  { timeout: 5000 },
  async () => {
    for (const [shape, makeStall] of [
      ['stalled body', stalledBodyRecorder],
      ['stalled fetch', stalledFetchRecorder],
    ] as const) {
      const stall = makeStall();
      const outcome = await withStubbedLocation(async () => {
        const { createContactsClient } = await import('../../src/api/contacts-client.ts');
        return await Effect.runPromise(
          createContactsClient({ timeoutMs: 25 }).pipe(
            Effect.flatMap((client) => client.foundation.readiness({})),
            Effect.as('completed' as const),
            Effect.catchTag('TimeoutError', () => Effect.succeed('timed-out' as const)),
            Effect.catchCause(() => Effect.succeed('other-failure' as const)),
            Effect.provideService(FetchHttpClient.Fetch, stall.fetch),
          ),
        );
      });

      assert.equal(outcome, 'timed-out', shape);
      assert.deepEqual(
        stall.attempts,
        [contactsUrl('https://shell.example', '/contacts/readiness')],
        shape,
      );
      assert.deepEqual(stall.aborts, stall.attempts, shape);
    }
  },
);

/** The same deadline must also cover a request that never produces a response at all. */
test('expires the whole-operation deadline on a stalled fetch without a second attempt', async () => {
  const attempts: string[] = [];
  const aborts: string[] = [];

  const stalledFetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    attempts.push(url);
    const pending = Promise.withResolvers<Response>();
    // Settling on abort rather than rejecting: the fiber is already interrupted, so this response is
    // discarded either way, and the test keeps no rejected promise of its own alive.
    init?.signal?.addEventListener('abort', () => {
      aborts.push(url);
      pending.resolve(new Response(null, { status: 499 }));
    });
    return await pending.promise;
  };

  const outcome = await withStubbedLocation(async () => {
    const { executeOrganizationEngagementProfileWithAuthorization } =
      await import('../../src/api/organization-engagement-profile-client.ts');
    return await Effect.runPromise(
      executeOrganizationEngagementProfileWithAuthorization(
        { profileRef: organizationRef },
        Redacted.make('Bearer stalled'),
        'correlation-stalled',
        { timeoutMs: 25 },
      ).pipe(
        Effect.as('completed' as const),
        Effect.catchTag('TimeoutError', () => Effect.succeed('timed-out' as const)),
        Effect.catchCause(() => Effect.succeed('other-failure' as const)),
        Effect.provideService(FetchHttpClient.Fetch, stalledFetch),
      ),
    );
  });

  assert.equal(outcome, 'timed-out');
  assert.equal(attempts.length, 1);
  assert.deepEqual(aborts, attempts);
});
