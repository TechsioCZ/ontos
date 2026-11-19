// @rstest-environment happy-dom
import { definePageData, modulePagePreload, moduleWriteEvent } from '@app/shared-contracts/page-data';
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { networkIdle, networkQuietExcept } from '@app/shared-contracts/testing/http-double';
import { HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Clock, Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { afterEach, beforeAll, expect, it, rstest } from 'effect-rstest';

import { ResolvedModuleTargetSchema } from '../../../shared/browser-api.ts';
import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import {
  awaitPrimaryModuleReads,
  clearBrowserRequestCache,
  forgetRecordedPageReads,
  installBrowserRequestCache,
  withoutRecordedPageReads,
} from '../../../src/routes/browser-request-cache.ts';
import { staffRoutePreloads } from '../../../src/routes/route-preload-scheduler.ts';
import { makeBrowserCacheNetwork } from '../../support/browser-cache-network.ts';
import { prepareModulePage, RemotePagePreparation } from '../../../src/routes/remote-page-loader.ts';

const revision = 'a'.repeat(64);
const audience = 'intent-fixture';
const fixture = makeBrowserCacheNetwork(audience, revision);
const { base } = fixture;
const manifestKey = 'ontos.page-reads.v1:/en/home';
const BodyJson = Schema.fromJsonString(Schema.Struct({ context: Schema.String, refreshToken: Schema.String }));

const read = (name: string, refreshToken = '', context = 'company-a', signal?: AbortSignal) =>
  Effect.promise((effectSignal) =>
    globalThis.fetch(`${base}/reads/${name}`, {
      body: Schema.encodeSync(BodyJson)({ context, refreshToken }),
      headers: {
        authorization: `Bearer ${fixture.token}`,
        'content-type': 'application/json',
        'x-ontos-composition-revision': revision,
      },
      method: 'POST',
      signal: signal ?? effectSignal,
    }),
  );
const prepareRead = (name: string) => withoutRecordedPageReads(() => browserRuntime.runPromise(read(name)));
beforeAll(() => {
  installBrowserRequestCache();
});
afterEach(() => {
  rstest.restoreAllMocks();
});

for (const firstToSettle of ['owner', 'dataset'] as const) {
  it.live(`keeps the single background slot until owner and detached dataset settle (${firstToSettle} first)`, () =>
    Effect.gen(function* retainedPreparationSlot() {
      yield* fixture.reset(true);
      const ownerRelease = yield* Deferred.make<boolean>();
      const datasetRelease = yield* Deferred.make<boolean>();
      const ownerStarted = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      let revalidating = false;
      const data = definePageData({
        key: (key: string) => key,
        load: () => Effect.suspend(() => (revalidating ? Deferred.await(datasetRelease) : Effect.succeed(true))),
        runtime: browserRuntime,
      });
      yield* data.preload('prepared');
      revalidating = true;
      const dataset = yield* data.refresh('prepared').pipe(Effect.forkChild({ startImmediately: true }));
      const ownerWork = withoutRecordedPageReads(
        () => browserRuntime.runPromise(data.preload('prepared').pipe(Effect.andThen(Deferred.await(ownerRelease)))),
        '/en/prepared',
      );
      yield* staffRoutePreloads.invalidate;
      yield* staffRoutePreloads.resume;
      yield* Effect.gen(function* checkDetachedDatasetSlot() {
        const first = yield* staffRoutePreloads
          .schedule(
            '/en/prepared',
            'background',
            Effect.forkDetach(ownerWork, { startImmediately: true }).pipe(
              Effect.flatMap((owner) => Deferred.succeed(ownerStarted, owner)),
              Effect.asVoid,
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        const owner = yield* Deferred.await(ownerStarted);
        const started: string[] = [];
        // The retained owner already fills the default single background slot.
        const next = yield* staffRoutePreloads
          .schedule(
            '/en/next',
            'background',
            Effect.sync(() => {
              started.push('next');
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(started).toEqual([]);
        if (firstToSettle === 'owner') {
          yield* Deferred.succeed(ownerRelease, true);
          yield* Fiber.join(owner);
        } else {
          yield* Deferred.succeed(datasetRelease, true);
          yield* Fiber.join(dataset);
        }
        expect(next.pollUnsafe()).toBeUndefined();
        expect(first.pollUnsafe()).toBeUndefined();
        expect(started).toEqual([]);
        yield* Deferred.succeed(ownerRelease, true);
        yield* Deferred.succeed(datasetRelease, true);
        yield* Fiber.join(owner);
        yield* Fiber.join(dataset);
        yield* Fiber.join(next);
        yield* Fiber.join(first);
        expect(started).toEqual(['next']);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* releaseOwnedWork() {
            yield* Deferred.succeed(ownerRelease, true);
            yield* Deferred.succeed(datasetRelease, true);
            yield* staffRoutePreloads.invalidate;
            yield* staffRoutePreloads.awaitIdle;
          }),
        ),
      );
    }).pipe(Effect.provide(fixture.network)),
  );
}

it.live('excludes several concurrent destinations without polluting the current visit replay', () =>
  Effect.gen(function* concurrentRecorderIsolation() {
    yield* fixture.reset(true);
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
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(4);
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
  }).pipe(Effect.provide(fixture.network)),
);

it.live('joins complete-body IO while foreground callers retain independent abort signals', () =>
  Effect.gen(function* foregroundJoin() {
    yield* fixture.reset(true);
    const pending = yield* fixture.hold('/reads/joined');
    const preparing = yield* prepareRead('joined').pipe(Effect.forkChild);
    yield* Deferred.await(pending.entered);
    const controller = new AbortController();
    const canceled = yield* read('joined', '', 'company-a', controller.signal).pipe(Effect.exit, Effect.forkChild);
    controller.abort();
    expect(Exit.isFailure(yield* Fiber.join(canceled))).toBe(true);
    const foreground = yield* read('joined').pipe(Effect.forkChild);
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'fresh' }));
    expect((yield* Fiber.join(preparing)).status).toBe(200);
    expect((yield* Fiber.join(foreground)).status).toBe(200);
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.signal.aborted).toBe(false);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('does not merge refresh tokens or company bodies into the cache key', () =>
  Effect.gen(function* completeBodyKeys() {
    yield* fixture.reset(true);
    yield* withoutRecordedPageReads(() => browserRuntime.runPromise(read('keys', 'refresh-a', 'company-a')));
    yield* read('keys', 'refresh-a', 'company-a');
    yield* networkIdle;
    expect(fixture.count).toBe(1);
    yield* read('keys', 'refresh-b', 'company-a');
    yield* read('keys', 'refresh-a', 'company-b');
    yield* networkIdle;
    expect(fixture.count).toBe(3);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('the primary-read gate ignores speculative requests issued after its snapshot', () =>
  Effect.gen(function* primarySnapshot() {
    yield* fixture.reset(true);
    const primary = yield* fixture.hold('/reads/primary');
    const speculative = yield* fixture.hold('/reads/later-speculation');
    const current = yield* read('primary').pipe(Effect.forkChild);
    yield* Deferred.await(primary.entered);
    const ready = yield* awaitPrimaryModuleReads.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const other = yield* prepareRead('later-speculation').pipe(Effect.forkChild);
    yield* Deferred.await(speculative.entered);
    yield* Deferred.succeed(primary.release, HttpServerResponse.jsonUnsafe({ value: 'primary' }));
    expect(yield* Fiber.join(ready)).toBe(true);
    expect(other.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(speculative.release, HttpServerResponse.jsonUnsafe({ value: 'destination' }));
    yield* Fiber.join(current);
    yield* Fiber.join(other);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('a timed-out declared owner cannot pollute replay or quarantine another preparation', () =>
  Effect.gen(function* independentOwnerLifetimes() {
    yield* fixture.reset(true);
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
  }).pipe(Effect.provide(fixture.network)),
);

it.live('a mutation restarts prepared reads that were still in flight, never returning the old answer as fresh', () =>
  Effect.gen(function* writeInvalidation() {
    yield* fixture.reset(true);
    yield* pinDocumentCompositionRevision(revision);
    const pending = yield* fixture.hold('/reads/mutated');
    const preparing = yield* prepareRead('mutated').pipe(Effect.forkChild);
    yield* Deferred.await(pending.entered);
    yield* Effect.promise(() => globalThis.fetch(`${base}/commands/change`, { body: '{}', method: 'POST' }));
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'old' }));
    const response = yield* Fiber.join(preparing);
    expect(yield* Effect.promise(() => response.json())).toEqual({ value: 'fresh' });
    yield* networkIdle;
    expect(fixture.count).toBe(4);
    expect(
      fixture.requests.filter(({ path }) => path.startsWith('/reads/')).map(({ authorization }) => authorization),
    ).toEqual([`Bearer ${fixture.token}`, 'Bearer t1']);
    yield* read('mutated');
    // Reads during write quiet time are joinable but are not retained as fresh settled data.
    yield* networkIdle;
    expect(fixture.count).toBe(5);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('clears prepared data on company/context changes and rejects pending old-context answers', () =>
  Effect.gen(function* contextInvalidation() {
    yield* fixture.reset(true);
    const pending = yield* fixture.hold('/reads/context');
    const preparing = yield* prepareRead('context').pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(pending.entered);
    yield* clearBrowserRequestCache;
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'old-context' }));
    expect(Exit.isFailure(yield* Fiber.join(preparing))).toBe(true);
    yield* read('context');
    yield* networkIdle;
    expect(fixture.count).toBe(2);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('the native sign-out cleanup drops memory reads, gateway assertions and every persisted visit', () =>
  Effect.gen(function* signOutInvalidation() {
    yield* fixture.reset(true);
    yield* read('signed-in');
    yield* read('signed-in');
    yield* networkIdle;
    expect(fixture.count).toBe(1);
    expect(globalThis.localStorage.getItem(manifestKey)).not.toBeNull();
    yield* forgetRecordedPageReads;
    expect(globalThis.localStorage.getItem(manifestKey)).toBeNull();
    yield* read('signed-in');
    yield* Effect.promise(fixture.gatewayRequest);
    yield* networkIdle;
    expect(fixture.count).toBe(3);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('does not wait for an already-started speculative destination when opening another page', () =>
  Effect.gen(function* noSpeculativeGate() {
    yield* fixture.reset(true);
    const pending = yield* fixture.hold('/reads/slow-destination');
    const preparing = yield* prepareRead('slow-destination').pipe(Effect.forkChild);
    yield* Deferred.await(pending.entered);
    expect(yield* awaitPrimaryModuleReads).toBe(true);
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'fresh' }));
    yield* Fiber.join(preparing);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('buffers the complete response body before either a preload or its foreground join receives data', () =>
  Effect.gen(function* completeBody() {
    yield* fixture.reset(true);
    const pending = yield* fixture.stream('/reads/body', JSON.stringify({ value: 'fresh' }));
    const preparing = yield* prepareRead('body').pipe(Effect.forkChild);
    yield* Deferred.await(pending.started);
    const foreground = yield* read('body').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(preparing.pollUnsafe()).toBeUndefined();
    expect(foreground.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(pending.release, true);
    const preparedResponse = yield* Fiber.join(preparing);
    const foregroundResponse = yield* Fiber.join(foreground);
    expect(yield* Effect.promise(() => preparedResponse.json())).toEqual({ value: 'fresh' });
    expect(yield* Effect.promise(() => foregroundResponse.json())).toEqual({ value: 'fresh' });
    yield* networkIdle;
    expect(fixture.count).toBe(1);
  }).pipe(Effect.provide(fixture.network)),
);

it.live('waits for fresh data after expiry instead of labeling an old prepared answer fresh', () =>
  Effect.gen(function* expiry() {
    yield* fixture.reset(true);
    const clock = browserRuntime.runSync(Clock.Clock);
    const now = rstest.spyOn(clock, 'currentTimeMillisUnsafe').mockReturnValue(100_000);
    yield* prepareRead('expiry');
    now.mockReturnValue(120_001);
    const pending = yield* fixture.hold('/reads/expiry');
    const foreground = yield* read('expiry').pipe(Effect.forkChild);
    yield* Deferred.await(pending.entered);
    expect(foreground.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'new' }));
    const response = yield* Fiber.join(foreground);
    expect(yield* Effect.promise(() => response.json())).toEqual({ value: 'new' });
  }).pipe(Effect.provide(fixture.network)),
);

it.live('shares a still-pending compatible request even after the freshness window has elapsed', () =>
  Effect.gen(function* slowJoin() {
    yield* fixture.reset(true);
    const clock = browserRuntime.runSync(Clock.Clock);
    const now = rstest.spyOn(clock, 'currentTimeMillisUnsafe').mockReturnValue(100_000);
    const pending = yield* fixture.hold('/reads/slow-join');
    const preparing = yield* prepareRead('slow-join').pipe(Effect.forkChild);
    yield* Deferred.await(pending.entered);
    now.mockReturnValue(120_001);
    const foreground = yield* read('slow-join').pipe(Effect.forkChild);
    yield* networkQuietExcept(1);
    expect(fixture.count).toBe(1);
    yield* Deferred.succeed(pending.release, HttpServerResponse.jsonUnsafe({ value: 'fresh' }));
    yield* Fiber.join(preparing);
    yield* Fiber.join(foreground);
    yield* networkIdle;
    expect(fixture.count).toBe(1);
  }).pipe(Effect.provide(fixture.network)),
);

const datasetTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'dataset',
  componentKey: 'dataset.core.page-dataset',
  compositionRevision: revision,
  entrypointKey: 'dataset.core.page.dataset',
  federation: {
    expose: './Dataset',
    manifest: { sha256: 'b'.repeat(64), url: 'https://assets.example.test/dataset/mf-manifest.json' },
    remoteName: 'datasetFixture',
  },
  moduleId: 'dataset.core',
  routeParameters: {},
  writable: false,
});

it.live('restarts the entire declared dataset across a write', () =>
  Effect.gen(function* datasetWriteReproducer() {
    yield* fixture.reset(true);
    const firstRead = yield* Deferred.make<boolean>();
    const releaseSecond = yield* Deferred.make<boolean>();
    fixture.enqueue('/reads/dataset-first', Effect.succeed(HttpServerResponse.jsonUnsafe({ value: 'old' })));
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
  }).pipe(Effect.provide(fixture.network)),
);

it.live('excludes detached stale revalidation after declared preload returns', () =>
  Effect.gen(function* detachedRecorderReproducer() {
    yield* fixture.reset(true);
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
  }).pipe(Effect.provide(fixture.network)),
);

it.live('releases detached-work exclusion on settlement without delaying stale-ready preload', () =>
  Effect.gen(function* detachedExclusionRelease() {
    yield* fixture.reset(true);
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
    yield* waitUntil(() => {
      const snapshot = data.snapshot('destination');
      return snapshot.state === 'ready' && !snapshot.refreshing && snapshot.value === 2;
    });
    expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: 2 });
    expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
    yield* read('foreground-after-detached');
    expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-detached');
  }).pipe(Effect.provide(fixture.network)),
);

it.live('a synchronous dataset factory defect cannot leak recorder exclusion into later visits', () =>
  Effect.gen(function* factoryExclusionRecovery() {
    yield* fixture.reset(true);
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
    yield* waitUntil(() => runs === 2);
    expect(runs).toBe(2);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(preparing);
    expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: 2 });
    yield* read('foreground-after-factory-defect');
    expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-factory-defect');
  }).pipe(Effect.provide(fixture.network)),
);

it.live(
  'obsolete datasets neither retry overtaken reads nor issue later reads, while their transport stays excluded',
  () =>
    Effect.gen(function* obsoleteDatasetTransport() {
      yield* fixture.reset(true);
      yield* read('before-obsolete-transport');
      const before = globalThis.localStorage.getItem(manifestKey);
      const beforeRequests = fixture.count;
      const pending = yield* fixture.stream('/reads/obsolete-first', JSON.stringify({ value: 'old' }));
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
      yield* Deferred.await(pending.started);
      yield* Effect.promise(() => globalThis.fetch(`${base}/commands/obsolete-change`, { body: '{}', method: 'POST' }));
      yield* Fiber.join(preparing);
      expect(data.snapshot('destination')).toEqual({ refreshing: false, state: 'ready', value: { value: 'fresh' } });
      // Old read + write + replacement's two reads. The body of the old read is still pending.
      yield* networkIdle;
      expect(fixture.count - beforeRequests).toBe(4);
      yield* read('foreground-during-obsolete-body');
      expect(globalThis.localStorage.getItem(manifestKey)).toBe(before);
      yield* Deferred.succeed(pending.release, true);
      yield* Deferred.await(pending.finished);
      yield* networkIdle;
      yield* Effect.yieldNow;
      expect(obsoleteContinuations).toBe(0);
      yield* networkIdle;
      expect(fixture.count - beforeRequests).toBe(5);
      yield* read('foreground-after-obsolete-body');
      yield* networkIdle;
      expect(fixture.count - beforeRequests).toBe(6);
      expect(globalThis.localStorage.getItem(manifestKey)).toContain('/reads/foreground-after-obsolete-body');
    }).pipe(Effect.provide(fixture.network)),
);
