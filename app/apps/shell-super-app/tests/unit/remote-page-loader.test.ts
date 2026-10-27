import type { ModulePagePreload, ModulePageProps } from '@app/shared-contracts/page-data';
import { Clock, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeEach, expect, it, rs } from 'effect-rstest';

import { prepareModulePage, RemotePagePreparation } from '../../src/routes/remote-page-loader.ts';
import type { loadRemotePage, ReadyRemotePage } from '../../src/routes/remote-page-loader.ts';

const transport = {
  load: rs.fn<typeof loadRemotePage>(),
  prefetch: rs.fn<(pathname: string) => Effect.Effect<void>>(),
};
// The remote's Promise-shaped public contract is the only boundary run on this owned runtime.
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const Component = () => null;
const readyPage = (preloadPage?: ModulePagePreload): ReadyRemotePage =>
  preloadPage === undefined ? { Component, state: 'ready' } : { Component, preloadPage, state: 'ready' };
const prepare: typeof prepareModulePage = (page, input, pathname, budget) =>
  prepareModulePage(page, input, pathname, budget).pipe(Effect.provideService(RemotePagePreparation, transport));
const target = (name: string): Parameters<typeof prepareModulePage>[0] => ({
  compositionRevision: '1'.repeat(64),
  federation: {
    expose: './HomeSummary',
    manifest: { sha256: '2'.repeat(64), url: `https://${name}.example.test/mf-manifest.json` },
    remoteName: name,
  },
});
const props: ModulePageProps = {
  context: {
    legalEntityId: 'company-one',
    principalId: 'person-one',
    tenantId: 'tenant-one',
  },
  routeParams: { clientId: 'client-one' },
  search: '?view=summary',
};

beforeEach(() => {
  transport.load.mockImplementation(() => Effect.succeed(readyPage()));
  transport.prefetch.mockImplementation(() => Effect.void);
});

it.effect('uses the declared preload instead of replaying the recorded request body', () =>
  Effect.gen(function* declaredPreloadOwnsData() {
    const preloadPage = rs.fn<ModulePagePreload>(() => runtime.runPromise(Effect.void));
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));

    const result = yield* prepare(target('declared'), props, '/cs', '2500 millis');

    expect(result).toEqual(Option.some({ Component, preloadPage, state: 'ready' }));
    expect(preloadPage).toHaveBeenCalledExactlyOnceWith(props);
    expect(transport.prefetch).not.toHaveBeenCalled();
  }),
);

it.effect('starts the legacy recorded fallback only after the module has loaded', () =>
  Effect.gen(function* legacyFallbackWaitsForModule() {
    const importing = yield* Deferred.make<boolean>();
    const imported = yield* Deferred.make<boolean>();
    transport.load.mockImplementation(() =>
      Deferred.succeed(importing, true).pipe(Effect.andThen(Deferred.await(imported)), Effect.as(readyPage())),
    );
    yield* Effect.gen(function* checkLegacyOrdering() {
      const preparation = yield* Effect.forkChild(prepare(target('legacy'), props, '/cs/legacy', '1 second'));
      yield* Deferred.await(importing);
      expect(transport.prefetch).not.toHaveBeenCalled();
      yield* Deferred.succeed(imported, true);

      expect(yield* Fiber.join(preparation)).toEqual(Option.some({ Component, state: 'ready' }));
      expect(transport.prefetch).toHaveBeenCalledExactlyOnceWith('/cs/legacy');
    }).pipe(Effect.ensuring(Deferred.succeed(imported, true)));
  }),
);

class PreloadUnavailable extends Schema.TaggedError<PreloadUnavailable>()('PreloadUnavailable', {}) {}

it.effect('does not replay recorded reads when the declared preload rejects', () =>
  Effect.gen(function* declaredFailureDoesNotFallback() {
    const preloadPage = rs.fn<ModulePagePreload>(() => runtime.runPromise(Effect.fail(new PreloadUnavailable())));
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));

    expect(yield* prepare(target('failed'), props, '/cs', '1 second')).toEqual(
      Option.some({ Component, preloadPage, state: 'ready' }),
    );
    expect(preloadPage).toHaveBeenCalledTimes(1);
    expect(transport.prefetch).not.toHaveBeenCalled();
  }),
);

it.effect('does not replay recorded reads when a declared preload reaches the caller budget', () =>
  Effect.gen(function* declaredBudgetDoesNotFallback() {
    const started = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<boolean>();
    const preloadPage = rs.fn<ModulePagePreload>(() =>
      runtime.runPromise(Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(finished)), Effect.asVoid)),
    );
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));

    yield* Effect.gen(function* checkDeclaredBudget() {
      const preparation = yield* Effect.forkChild(prepare(target('budget'), props, '/cs', '100 millis'));
      yield* Deferred.await(started);
      yield* TestClock.adjust('100 millis');

      expect(yield* Fiber.join(preparation)).toEqual(Option.none());
      expect(preloadPage).toHaveBeenCalledTimes(1);
      expect(transport.prefetch).not.toHaveBeenCalled();
    }).pipe(Effect.ensuring(Deferred.succeed(finished, true)));
  }),
);

it.effect('keeps the declared preload limit without starting the recorded fallback', () =>
  Effect.gen(function* declaredLimitDoesNotFallback() {
    const started = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<boolean>();
    const preloadPage = rs.fn<ModulePagePreload>(() =>
      runtime.runPromise(Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(finished)), Effect.asVoid)),
    );
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));

    yield* Effect.gen(function* checkDeclaredLimit() {
      const preparation = yield* Effect.forkChild(prepare(target('limit'), props, '/cs', '40 seconds'));
      yield* Deferred.await(started);
      yield* TestClock.adjust('30 seconds');

      expect(yield* Fiber.join(preparation)).toEqual(Option.some({ Component, preloadPage, state: 'ready' }));
      expect(transport.prefetch).not.toHaveBeenCalled();
    }).pipe(Effect.ensuring(Deferred.succeed(finished, true)));
  }),
);

it.effect('charges module loading and the legacy fallback against the same caller budget', () =>
  Effect.gen(function* legacyBudgetIncludesModuleLoading() {
    const importing = yield* Deferred.make<boolean>();
    const imported = yield* Deferred.make<boolean>();
    const reading = yield* Deferred.make<boolean>();
    let interrupted = false;
    transport.load.mockImplementation(() =>
      Deferred.succeed(importing, true).pipe(Effect.andThen(Deferred.await(imported)), Effect.as(readyPage())),
    );
    transport.prefetch.mockImplementation(() =>
      Deferred.succeed(reading, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );

    yield* Effect.gen(function* checkSharedBudget() {
      const start = yield* Clock.currentTimeMillis;
      const preparation = yield* Effect.forkChild(prepare(target('legacy-budget'), props, '/cs/legacy', '100 millis'));
      yield* Deferred.await(importing);
      yield* TestClock.adjust('80 millis');
      yield* Deferred.succeed(imported, true);
      yield* Deferred.await(reading);
      expect((yield* Clock.currentTimeMillis) - start).toBe(80);
      yield* TestClock.adjust('20 millis');

      expect(yield* Fiber.join(preparation)).toEqual(Option.none());
      expect(interrupted).toBe(true);
      expect((yield* Clock.currentTimeMillis) - start).toBe(100);
    }).pipe(Effect.ensuring(Deferred.succeed(imported, true)));
  }),
);

it.effect('interrupts its fallback wait when the caller leaves the page', () =>
  Effect.gen(function* callerOwnsFallbackWait() {
    const reading = yield* Deferred.make<boolean>();
    let interrupted = false;
    transport.prefetch.mockImplementation(() =>
      Deferred.succeed(reading, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const preparation = yield* Effect.forkChild(prepare(target('interrupted'), props, '/cs/legacy', '1 second'));
    yield* Deferred.await(reading);
    yield* Fiber.interrupt(preparation);
    const exit = yield* Fiber.await(preparation);

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(interrupted).toBe(true);
    expect(transport.prefetch).toHaveBeenCalledTimes(1);
  }),
);

it.effect('does not start the fallback when module loading consumes the caller budget', () =>
  Effect.gen(function* moduleLoadingOwnsRemainingBudget() {
    const importing = yield* Deferred.make<boolean>();
    transport.load.mockImplementation(() => Deferred.succeed(importing, true).pipe(Effect.andThen(Effect.never)));
    const preparation = yield* Effect.forkChild(prepare(target('slow-module'), props, '/cs/legacy', '100 millis'));
    yield* Deferred.await(importing);
    yield* TestClock.adjust('100 millis');

    expect(yield* Fiber.join(preparation)).toEqual(Option.none());
    expect(transport.prefetch).not.toHaveBeenCalled();
  }),
);

it.effect('interrupts the declared wait without replacing or taking ownership of the remote Promise', () =>
  Effect.gen(function* remoteOwnsDeclaredPromise() {
    const started = yield* Deferred.make<boolean>();
    const released = yield* Deferred.make<boolean>();
    const settled = yield* Deferred.make<boolean>();
    const preloadPage = rs.fn<ModulePagePreload>(() =>
      runtime.runPromise(
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Deferred.await(released)),
          Effect.andThen(Deferred.succeed(settled, true)),
          Effect.asVoid,
        ),
      ),
    );
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));

    yield* Effect.gen(function* checkDeclaredInterruption() {
      const preparation = yield* Effect.forkChild(prepare(target('remote-promise'), props, '/cs', '1 second'));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(preparation);

      expect(Exit.hasInterrupts(yield* Fiber.await(preparation))).toBe(true);
      expect(yield* Deferred.isDone(settled)).toBe(false);
      expect(transport.prefetch).not.toHaveBeenCalled();
      yield* Deferred.succeed(released, true);
      yield* Deferred.await(settled);
      expect(preloadPage).toHaveBeenCalledTimes(1);
    }).pipe(Effect.ensuring(Deferred.succeed(released, true)));
  }),
);

it.effect('does not share declared preload work between contexts using the same module', () =>
  Effect.gen(function* independentPreloadContexts() {
    const preloadPage = rs.fn<ModulePagePreload>(() => runtime.runPromise(Effect.void));
    transport.load.mockImplementation(() => Effect.succeed(readyPage(preloadPage)));
    const otherProps: ModulePageProps = {
      ...props,
      context: { ...props.context, legalEntityId: 'company-two', principalId: 'person-two', tenantId: 'tenant-two' },
    };
    const sharedTarget = target('shared-code');

    yield* Effect.all(
      [prepare(sharedTarget, props, '/cs', '1 second'), prepare(sharedTarget, otherProps, '/cs', '1 second')],
      { concurrency: 2 },
    );

    expect(transport.load).toHaveBeenCalledTimes(2);
    expect(preloadPage).toHaveBeenCalledTimes(2);
    expect(preloadPage).toHaveBeenCalledWith(props);
    expect(preloadPage).toHaveBeenCalledWith(otherProps);
    expect(transport.prefetch).not.toHaveBeenCalled();
  }),
);
