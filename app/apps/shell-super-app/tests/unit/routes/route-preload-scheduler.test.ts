import { Deferred, Effect, Fiber } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeRoutePreloadScheduler } from '../../../src/routes/route-preload-scheduler.ts';

it.effect('bounds the shared background pool and drains every destination', () =>
  Effect.gen(function* boundedPrefetch() {
    const queue = makeRoutePreloadScheduler(2);
    const release = yield* Deferred.make<boolean>();
    const started: number[] = [];
    yield* queue.resume;
    const flights = yield* Effect.forEach([0, 1, 2, 3, 4, 5], (key) =>
      queue
        .schedule(
          `/en/page-${key}`,
          'background',
          Effect.sync(() => {
            started.push(key);
          }).pipe(Effect.andThen(Deferred.await(release).pipe(Effect.asVoid))),
        )
        .pipe(Effect.forkChild({ startImmediately: true })),
    );
    yield* Effect.yieldNow;
    expect(started).toEqual([0, 1]);
    yield* Deferred.succeed(release, true);
    yield* Effect.all(
      flights.map((fiber) => Fiber.join(fiber)),
      { concurrency: 6, discard: true },
    );
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  }),
);

it.effect('joins and promotes intent without duplicating a queued or active route', () =>
  Effect.gen(function* intentPriority() {
    const queue = makeRoutePreloadScheduler(1);
    const release = yield* Deferred.make<boolean>();
    const started: string[] = [];
    const schedule = (key: string) =>
      queue
        .schedule(
          key,
          'background',
          Effect.sync(() => {
            started.push(key);
          }).pipe(Effect.andThen(Deferred.await(release).pipe(Effect.asVoid))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
    yield* queue.resume;
    const first = yield* schedule('/first');
    const second = yield* schedule('/second');
    const intended = yield* schedule('/intended');
    yield* Effect.yieldNow;
    const joined = yield* queue
      .schedule('/intended', 'intent', Effect.die('must join the queued work'))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    expect(started).toEqual(['/first', '/intended']);
    yield* Deferred.succeed(release, true);
    yield* Effect.forEach([first, second, intended, joined], (fiber) => Fiber.join(fiber));
    expect(started).toEqual(['/first', '/intended', '/second']);
  }),
);

it.effect('pauses queued work during navigation without canceling a started native flight', () =>
  Effect.gen(function* foregroundFirst() {
    const queue = makeRoutePreloadScheduler(1);
    const release = yield* Deferred.make<boolean>();
    const started: string[] = [];
    yield* queue.resume;
    const first = yield* queue
      .schedule('/first', 'background', Deferred.await(release).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    const next = yield* queue
      .schedule(
        '/next',
        'background',
        Effect.sync(() => {
          started.push('next');
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* queue.pause;
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(first);
    expect(started).toEqual([]);
    yield* queue.resume;
    yield* Fiber.join(next);
    expect(started).toEqual(['next']);
  }),
);

it.effect('holds a slot past router settlement until retained owner work really settles', () =>
  Effect.gen(function* detachedOwnerLifetime() {
    const queue = makeRoutePreloadScheduler(1);
    const releaseRouter = yield* Deferred.make<boolean>();
    yield* queue.resume;
    const first = yield* queue
      .schedule('/first?filter=active#rows', 'background', Deferred.await(releaseRouter).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const releaseOwner = yield* queue.retain('/first?filter=active');
    const started: string[] = [];
    const next = yield* queue
      .schedule(
        '/next',
        'background',
        Effect.sync(() => {
          started.push('next');
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(releaseRouter, true);
    yield* Effect.yieldNow;
    expect(first.pollUnsafe()).toBeUndefined();
    expect(started).toEqual([]);
    yield* releaseOwner;
    yield* Effect.forEach([first, next], (fiber) => Fiber.join(fiber));
    expect(started).toEqual(['next']);
  }),
);

it.effect('invalidates old queued work but keeps active resource accounting until settlement', () =>
  Effect.gen(function* contextBoundary() {
    const queue = makeRoutePreloadScheduler(1);
    const release = yield* Deferred.make<boolean>();
    yield* queue.resume;
    const active = yield* queue
      .schedule('/active', 'background', Deferred.await(release).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    const obsolete = yield* queue
      .schedule('/old', 'background', Effect.die('obsolete context must not run'))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* queue.invalidate;
    yield* Fiber.join(obsolete);
    const started: string[] = [];
    const fresh = yield* queue
      .schedule(
        '/active',
        'background',
        Effect.sync(() => {
          started.push('fresh context');
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* queue.resume;
    expect(started).toEqual([]);
    yield* Deferred.succeed(release, true);
    yield* Effect.forEach([active, fresh], (fiber) => Fiber.join(fiber));
    expect(started).toEqual(['fresh context']);
  }),
);
