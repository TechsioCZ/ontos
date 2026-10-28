import { definePageData, modulePagePreload, moduleWriteEvent } from '@app/shared-contracts/page-data';
import { waitFor } from '@testing-library/react';
import { Clock, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { ResolvedModuleTargetSchema } from '../../../shared/api.ts';
import type { issueDocumentGatewayContexts as IssueDocumentGatewayContexts } from '../../../src/api/auth-client.ts';
import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import {
  awaitPrimaryModuleReads,
  clearBrowserRequestCache,
  forgetRecordedPageReads,
  installBrowserRequestCache,
  withoutRecordedPageReads,
} from '../../../src/routes/browser-request-cache.ts';
import { seedDocumentGatewayAssertions } from '../../../src/routes/document-gateway-assertions.ts';
import { prepareModulePage, RemotePagePreparation } from '../../../src/routes/remote-page-loader.ts';

const { issueDocumentGatewayContexts } = rstest.hoisted(() => ({
  issueDocumentGatewayContexts: rstest.fn<typeof IssueDocumentGatewayContexts>(),
}));
rstest.mock('../../../src/api/auth-client.ts', () => ({ issueDocumentGatewayContexts }));

const revision = 'a'.repeat(64);
const audience = 'intent-fixture';
const token = 'intent-fixture-token';
const base = `/shell-super-app-api/module-api/${audience}/build/fixture`;
const manifestKey = 'ontos.page-reads.v1:/en/home';
const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;
const BodyJson = Schema.fromJsonString(Schema.Struct({ context: Schema.String, refreshToken: Schema.String }));

const read = (name: string, refreshToken = '', context = 'company-a', signal?: AbortSignal) =>
  Effect.promise((effectSignal) =>
    globalThis.fetch(`${base}/reads/${name}`, {
      body: Schema.encodeSync(BodyJson)({ context, refreshToken }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-ontos-composition-revision': revision,
      },
      method: 'POST',
      signal: signal ?? effectSignal,
    }),
  );
const prepareRead = (name: string) => withoutRecordedPageReads(() => browserRuntime.runPromise(read(name)));
const gatewayRequest = () =>
  globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
    body: JSON.stringify({ audience, compositionRevision: revision }),
    method: 'POST',
  });

beforeAll(() => {
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  rstest.restoreAllMocks();
});
beforeEach(async () => {
  globalThis.history.replaceState(null, '', '/en/home');
  globalThis.localStorage.clear();
  platformFetch.mockReset();
  platformFetch.mockImplementation(async () => Response.json({ value: 'fresh' }));
  await browserRuntime.runPromise(
    clearBrowserRequestCache.pipe(
      Effect.andThen(
        seedDocumentGatewayAssertions(revision, [
          { apiBaseUrl: base, audience, compositionRevision: revision, expiresAt: 4_102_444_800, token },
        ]),
      ),
    ),
  );
  await gatewayRequest();
});

it.live('excludes several concurrent destinations without polluting the current visit replay', () =>
  Effect.gen(function* concurrentRecorderIsolation() {
    yield* read('current-page');
    const before = globalThis.localStorage.getItem(manifestKey);
    expect(before).toContain('/reads/current-page');
    const releases = yield* Effect.forEach(['finance', 'operations', 'contacts'], () => Deferred.make<boolean>(), {
      concurrency: 3,
    });
    const started = yield* Deferred.make<boolean>();
    const fibers = yield* Effect.forEach(
      releases,
      (release, index) =>
        withoutRecordedPageReads(() =>
          browserRuntime.runPromise(
            read(`destination-${index}`).pipe(
              Effect.andThen(Deferred.succeed(started, true)),
              Effect.andThen(Deferred.await(release)),
            ),
          ),
        ).pipe(Effect.forkDetach),
      { concurrency: 3 },
    );
    yield* Deferred.await(started);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(4)));
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
    for (let index = 0; index < releases.length; index += 1) {
      const release = releases[index];
      const fiber = fibers[index];
      if (release !== undefined && fiber !== undefined) {
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(fiber);
      }
      if (index < releases.length - 1) {
        yield* read(`overlapping-foreground-${index}`);
        expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
      }
    }
    yield* read('foreground-after-settlement');
    expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-settlement');
  }),
);

it.live('joins complete-body IO while foreground callers retain independent abort signals', () =>
  Effect.gen(function* foregroundJoin() {
    const release = yield* Deferred.make<Response>();
    platformFetch.mockImplementation(() => browserRuntime.runPromise(Deferred.await(release)));
    const preparing = yield* prepareRead('joined').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    const controller = new AbortController();
    const canceled = yield* read('joined', '', 'company-a', controller.signal).pipe(Effect.exit, Effect.forkChild);
    controller.abort();
    expect(Exit.isFailure(yield* Fiber.join(canceled))).toBe(true);
    const foreground = yield* read('joined').pipe(Effect.forkChild);
    yield* Deferred.succeed(release, Response.json({ value: 'fresh' }));
    expect((yield* Fiber.join(preparing)).status).toBe(200);
    expect((yield* Fiber.join(foreground)).status).toBe(200);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(platformFetch.mock.calls[0]?.[1]?.signal).toBeUndefined();
  }),
);

it.live('does not merge refresh tokens or company bodies into the cache key', () =>
  Effect.gen(function* completeBodyKeys() {
    yield* withoutRecordedPageReads(() => browserRuntime.runPromise(read('keys', 'refresh-a', 'company-a')));
    yield* read('keys', 'refresh-a', 'company-a');
    expect(platformFetch).toHaveBeenCalledTimes(1);
    yield* read('keys', 'refresh-b', 'company-a');
    yield* read('keys', 'refresh-a', 'company-b');
    expect(platformFetch).toHaveBeenCalledTimes(3);
  }),
);

it.live('the primary-read gate ignores speculative requests issued after its snapshot', () =>
  Effect.gen(function* primarySnapshot() {
    const primary = yield* Deferred.make<Response>();
    const speculative = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(primary)));
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(speculative)));
    const current = yield* read('primary').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    const ready = yield* awaitPrimaryModuleReads.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const other = yield* prepareRead('later-speculation').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(2)));
    yield* Deferred.succeed(primary, Response.json({ value: 'primary' }));
    expect(yield* Fiber.join(ready)).toBe(true);
    expect(other.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(speculative, Response.json({ value: 'destination' }));
    yield* Fiber.join(current);
    yield* Fiber.join(other);
  }),
);

it.live('a timed-out declared owner cannot pollute replay or quarantine another preparation', () =>
  Effect.gen(function* independentOwnerLifetimes() {
    yield* read('before-owner');
    const before = globalThis.localStorage.getItem(manifestKey);
    const release = yield* Deferred.make<boolean>();
    const started = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<boolean>();
    const preloadPage = () =>
      browserRuntime.runPromise(
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(read('late-destination')),
          Effect.andThen(Deferred.succeed(finished, true)),
          Effect.asVoid,
        ),
      );
    const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
      appId: 'contacts',
      componentKey: 'contacts.core.page-customers',
      compositionRevision: revision,
      entrypointKey: 'contacts.core.page.customers',
      federation: {
        expose: './Customers',
        manifest: { sha256: 'b'.repeat(64), url: 'https://assets.example.test/intent/mf-manifest.json' },
        remoteName: 'intentFixture',
      },
      moduleId: 'contacts.core',
      routeParameters: {},
      writable: true,
    });
    const preparing = yield* prepareModulePage(
      target,
      { routeParams: {}, search: '' },
      '/en/contacts',
      '20 millis',
    ).pipe(
      Effect.provideService(RemotePagePreparation, {
        load: () => Effect.succeed({ Component: () => null, preloadPage, state: 'ready' }),
        prefetch: () => Effect.die('declared preload must not replay recorded reads'),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    expect(Option.isNone(yield* Fiber.join(preparing))).toBe(true);
    yield* prepareRead('another-destination');
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
    yield* Deferred.succeed(release, true);
    yield* Deferred.await(finished);
    yield* Effect.yieldNow;
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
  }),
);

it.live('a mutation restarts prepared reads that were still in flight, never returning the old answer as fresh', () =>
  Effect.gen(function* writeInvalidation() {
    const old = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(old)));
    const preparing = yield* prepareRead('mutated').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    yield* Effect.promise(() => globalThis.fetch(`${base}/commands/change`, { body: '{}', method: 'POST' }));
    yield* Deferred.succeed(old, Response.json({ value: 'old' }));
    const response = yield* Fiber.join(preparing);
    expect(yield* Effect.promise(() => response.json())).toEqual({ value: 'fresh' });
    expect(platformFetch).toHaveBeenCalledTimes(3);
    yield* read('mutated');
    // Reads during write quiet time are joinable but are not retained as fresh settled data.
    expect(platformFetch).toHaveBeenCalledTimes(4);
  }),
);

it.live('clears prepared data on company/context changes and rejects pending old-context answers', () =>
  Effect.gen(function* contextInvalidation() {
    const old = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(old)));
    const preparing = yield* prepareRead('context').pipe(Effect.exit, Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(old, Response.json({ value: 'old-context' }));
    expect(Exit.isFailure(yield* Fiber.join(preparing))).toBe(true);
    yield* read('context');
    expect(platformFetch).toHaveBeenCalledTimes(2);
  }),
);

it.live('the native sign-out cleanup drops memory reads, gateway assertions and every persisted visit', () =>
  Effect.gen(function* signOutInvalidation() {
    yield* read('signed-in');
    yield* read('signed-in');
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(globalThis.localStorage.getItem(manifestKey)).not.toBeNull();
    yield* forgetRecordedPageReads;
    expect(globalThis.localStorage.getItem(manifestKey)).toBeNull();
    yield* read('signed-in');
    platformFetch.mockResolvedValueOnce(Response.json({ apiBaseUrl: base, expiresAt: 4_102_444_800, token }));
    yield* Effect.promise(gatewayRequest);
    expect(platformFetch).toHaveBeenCalledTimes(3);
  }),
);

it.live('does not wait for an already-started speculative destination when opening another page', () =>
  Effect.gen(function* noSpeculativeGate() {
    const release = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(release)));
    const preparing = yield* prepareRead('slow-destination').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    expect(yield* awaitPrimaryModuleReads).toBe(true);
    yield* Deferred.succeed(release, Response.json({ value: 'fresh' }));
    yield* Fiber.join(preparing);
  }),
);

it.live('buffers the complete response body before either a preload or its foreground join receives data', () =>
  Effect.gen(function* completeBody() {
    const release = yield* Deferred.make<ArrayBuffer>();
    const bodyStarted = yield* Deferred.make<boolean>();
    const response = Response.json({ value: 'fresh' });
    const bytes = yield* Effect.promise(() => response.clone().arrayBuffer());
    rstest
      .spyOn(response, 'arrayBuffer')
      .mockImplementation(() =>
        browserRuntime.runPromise(Deferred.succeed(bodyStarted, true).pipe(Effect.andThen(Deferred.await(release)))),
      );
    platformFetch.mockResolvedValueOnce(response);
    const preparing = yield* prepareRead('body').pipe(Effect.forkChild);
    yield* Deferred.await(bodyStarted);
    const foreground = yield* read('body').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(preparing.pollUnsafe()).toBeUndefined();
    expect(foreground.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, bytes);
    const preparedResponse = yield* Fiber.join(preparing);
    const foregroundResponse = yield* Fiber.join(foreground);
    expect(yield* Effect.promise(() => preparedResponse.json())).toEqual({ value: 'fresh' });
    expect(yield* Effect.promise(() => foregroundResponse.json())).toEqual({ value: 'fresh' });
    expect(platformFetch).toHaveBeenCalledTimes(1);
  }),
);

it.live('waits for fresh data after expiry instead of labeling an old prepared answer fresh', () =>
  Effect.gen(function* expiry() {
    const clock = browserRuntime.runSync(Clock.Clock);
    const now = rstest.spyOn(clock, 'currentTimeMillisUnsafe').mockReturnValue(100_000);
    yield* prepareRead('expiry');
    now.mockReturnValue(120_001);
    const fresh = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(fresh)));
    const foreground = yield* read('expiry').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(2)));
    expect(foreground.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(fresh, Response.json({ value: 'new' }));
    const response = yield* Fiber.join(foreground);
    expect(yield* Effect.promise(() => response.json())).toEqual({ value: 'new' });
  }),
);

it.live('shares a still-pending compatible request even after the freshness window has elapsed', () =>
  Effect.gen(function* slowJoin() {
    const clock = browserRuntime.runSync(Clock.Clock);
    const now = rstest.spyOn(clock, 'currentTimeMillisUnsafe').mockReturnValue(100_000);
    const release = yield* Deferred.make<Response>();
    platformFetch.mockImplementationOnce(() => browserRuntime.runPromise(Deferred.await(release)));
    const preparing = yield* prepareRead('slow-join').pipe(Effect.forkChild);
    yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(1)));
    now.mockReturnValue(120_001);
    const foreground = yield* read('slow-join').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(platformFetch).toHaveBeenCalledTimes(1);
    yield* Deferred.succeed(release, Response.json({ value: 'fresh' }));
    yield* Fiber.join(preparing);
    yield* Fiber.join(foreground);
    expect(platformFetch).toHaveBeenCalledTimes(1);
  }),
);

const datasetTarget = {
  compositionRevision: revision,
  federation: {
    expose: './Dataset',
    manifest: { sha256: 'b'.repeat(64), url: 'https://assets.example.test/dataset/mf-manifest.json' },
    remoteName: 'datasetFixture',
  },
};

it.live('restarts the entire declared dataset across a write', () =>
  Effect.gen(function* datasetWriteReproducer() {
    const firstRead = yield* Deferred.make<boolean>();
    const releaseSecond = yield* Deferred.make<boolean>();
    platformFetch.mockImplementationOnce(async () => Response.json({ value: 'old' }));
    const data = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.gen(function* loadDataset() {
          const firstResponse = yield* read('dataset-first');
          const first = yield* Effect.promise(() => firstResponse.json());
          yield* Deferred.succeed(firstRead, true);
          yield* Deferred.await(releaseSecond);
          const secondResponse = yield* read('dataset-second');
          const second = yield* Effect.promise(() => secondResponse.json());
          return { first, second };
        }),
      runtime: browserRuntime,
    });
    const preloadPage = modulePagePreload(() => data.preload('company-a'));
    const prepare = () =>
      prepareModulePage(datasetTarget, { routeParams: {}, search: '' }, '/en/dataset', '1 second').pipe(
        Effect.provideService(RemotePagePreparation, {
          load: () => Effect.succeed({ Component: () => null, preloadPage, state: 'ready' }),
          prefetch: () => Effect.void,
        }),
      );
    const original = yield* prepare().pipe(Effect.forkChild);
    yield* Deferred.await(firstRead);
    yield* Effect.promise(() => globalThis.fetch(`${base}/commands/dataset-change`, { body: '{}', method: 'POST' }));
    yield* Fiber.interrupt(original);
    const restarted = yield* prepare().pipe(Effect.forkChild);
    yield* Deferred.succeed(releaseSecond, true);
    yield* Fiber.join(restarted);
    expect(data.snapshot('company-a')).toEqual({
      refreshing: false,
      state: 'ready',
      value: { first: { value: 'fresh' }, second: { value: 'fresh' } },
    });
  }),
);

it.live('excludes detached stale revalidation after declared preload returns', () =>
  Effect.gen(function* detachedRecorderReproducer() {
    const renewal = yield* Deferred.make<boolean>();
    const refreshed = yield* Deferred.make<boolean>();
    let runs = 0;
    const data = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.gen(function* revalidateDataset() {
          runs += 1;
          if (runs > 1) {
            yield* Deferred.await(renewal);
            yield* read('late-revalidation');
            yield* Deferred.succeed(refreshed, true);
          }
          return runs;
        }),
      runtime: browserRuntime,
    });
    yield* data.preload('destination');
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* read('current-before-revalidation');
    const before = globalThis.localStorage.getItem(manifestKey);
    const preloadPage = modulePagePreload(() => data.preload('destination'));
    yield* prepareModulePage(datasetTarget, { routeParams: {}, search: '' }, '/en/dataset', '1 second').pipe(
      Effect.provideService(RemotePagePreparation, {
        load: () => Effect.succeed({ Component: () => null, preloadPage, state: 'ready' }),
        prefetch: () => Effect.void,
      }),
    );
    yield* Deferred.succeed(renewal, true);
    yield* Deferred.await(refreshed);
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
  }),
);

it.live('releases detached-work exclusion on settlement without delaying stale-ready preload', () =>
  Effect.gen(function* detachedExclusionRelease() {
    const renewal = yield* Deferred.make<boolean>();
    let runs = 0;
    const data = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.suspend(() => {
          runs += 1;
          const value = runs;
          return value === 1
            ? Effect.succeed(value)
            : Deferred.await(renewal).pipe(Effect.andThen(read('detached-before-release')), Effect.as(value));
        }),
      runtime: browserRuntime,
    });
    yield* data.preload('destination');
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* read('foreground-before-detached');
    const before = globalThis.localStorage.getItem(manifestKey);
    const preloadPage = modulePagePreload(() => data.preload('destination'));
    yield* withoutRecordedPageReads(() => preloadPage({ routeParams: {}, search: '' }));
    // The public preload has resolved while revalidation remains blocked.
    expect(data.snapshot('destination')).toEqual({ refreshing: true, state: 'ready', value: 1 });
    yield* Deferred.succeed(renewal, true);
    yield* Effect.promise(() =>
      waitFor(() => expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: 2 })),
    );
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
    yield* read('foreground-after-detached');
    expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-detached');
  }),
);

it.live('a synchronous dataset factory defect cannot leak recorder exclusion into later visits', () =>
  Effect.gen(function* factoryExclusionRecovery() {
    const release = yield* Deferred.make<boolean>();
    let runs = 0;
    const data = definePageData({
      key: (input: string) => input,
      load: () => {
        runs += 1;
        if (runs === 1) {
          throw new Error('synchronous factory defect');
        }
        return Deferred.await(release).pipe(Effect.as(runs));
      },
      runtime: browserRuntime,
    });
    const preloadPage = modulePagePreload(() => data.preload('destination'));
    yield* withoutRecordedPageReads(() => preloadPage({ routeParams: {}, search: '' }));
    const preparing = yield* withoutRecordedPageReads(() => preloadPage({ routeParams: {}, search: '' })).pipe(
      Effect.forkChild,
    );
    yield* Effect.promise(() => waitFor(() => expect(runs).toBe(2)));
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(preparing);
    expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: 2 });
    yield* read('foreground-after-factory-defect');
    expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-factory-defect');
  }),
);

it.live(
  'obsolete datasets neither retry overtaken reads nor issue later reads, while their transport stays excluded',
  () =>
    Effect.gen(function* obsoleteDatasetTransport() {
      yield* read('before-obsolete-transport');
      const before = globalThis.localStorage.getItem(manifestKey);
      platformFetch.mockClear();
      const release = yield* Deferred.make<ArrayBuffer>();
      const bodyStarted = yield* Deferred.make<boolean>();
      const response = Response.json({ value: 'old' });
      const bytes = yield* Effect.promise(() => response.clone().arrayBuffer());
      rstest
        .spyOn(response, 'arrayBuffer')
        .mockImplementation(() =>
          browserRuntime.runPromise(Deferred.succeed(bodyStarted, true).pipe(Effect.andThen(Deferred.await(release)))),
        );
      platformFetch.mockResolvedValueOnce(response);
      let runs = 0;
      let obsoleteContinuations = 0;
      const data = definePageData({
        key: (input: string) => input,
        load: () =>
          Effect.gen(function* loadTwoReads() {
            runs += 1;
            const run = runs;
            const first = yield* read('obsolete-first');
            if (run === 1) {
              obsoleteContinuations += 1;
            }
            yield* read('obsolete-second');
            return yield* Effect.promise(() => first.json());
          }),
        runtime: browserRuntime,
      });
      const preloadPage = modulePagePreload(() => data.preload('destination'));
      const preparing = yield* withoutRecordedPageReads(() => preloadPage({ routeParams: {}, search: '' })).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(bodyStarted);
      yield* Effect.promise(() => globalThis.fetch(`${base}/commands/obsolete-change`, { body: '{}', method: 'POST' }));
      yield* Fiber.join(preparing);
      expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: { value: 'fresh' } });
      // Old read + write + replacement's two reads. The body of the old read is still pending.
      expect(platformFetch).toHaveBeenCalledTimes(4);
      yield* read('foreground-during-obsolete-body');
      expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
      yield* Deferred.succeed(release, bytes);
      yield* Effect.yieldNow;
      expect(obsoleteContinuations).toBe(0);
      expect(platformFetch).toHaveBeenCalledTimes(5);
      yield* read('foreground-after-obsolete-body');
      expect(platformFetch).toHaveBeenCalledTimes(6);
      expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-obsolete-body');
    }),
);
