import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { makeIntentLimiter, whenBrowserIdle } from '../../src/row-intent.ts';

/** A fake intent read: records that it started and hands back its `done`. */
const harness = () => {
  const started: number[] = [];
  const pending = new Map<number, () => void>();
  const limit = makeIntentLimiter(2);
  const intent = (row: number) =>
    limit((done) => {
      started.push(row);
      pending.set(row, done);
    });
  const settle = (row: number) => pending.get(row)?.();
  return { intent, settle, started };
};

it('runs at most two intent reads and keeps only the newest waiting', () => {
  const { intent, settle, started } = harness();
  for (let row = 0; row < 20; row += 1) {
    intent(row);
  }
  expect(started).toEqual([0, 1]);
  settle(0);
  expect(started).toEqual([0, 1, 19]);
  settle(1);
  settle(19);
  expect(started).toEqual([0, 1, 19]);
});

it('a settled read frees its slot once, even when done is called twice', () => {
  const { intent, settle, started } = harness();
  intent(0);
  intent(1);
  settle(0);
  settle(0);
  intent(2);
  intent(3);
  expect(started).toEqual([0, 1, 2]);
  settle(1);
  expect(started).toEqual([0, 1, 2, 3]);
});

it('a read that settles at once leaves the slot free for the next intent', () => {
  const started: number[] = [];
  const limit = makeIntentLimiter(1);
  for (let row = 0; row < 3; row += 1) {
    limit((done) => {
      started.push(row);
      done();
    });
  }
  expect(started).toEqual([0, 1, 2]);
});

it('a read that throws while starting frees its slot', () => {
  const limit = makeIntentLimiter(1);
  expect(() =>
    limit(() => {
      throw new Error('start failed');
    }),
  ).toThrow('start failed');
  const started: number[] = [];
  limit(() => {
    started.push(1);
  });
  expect(started).toEqual([1]);
});

/** Sets `state.done` once the wait completes. */
const markDone = (state: { done: boolean }) =>
  whenBrowserIdle.pipe(
    Effect.andThen(
      Effect.sync(() => {
        state.done = true;
      }),
    ),
  );

afterEach(() => {
  rstest.unstubAllGlobals();
});

it.effect('waits the fallback delay where requestIdleCallback is missing', () =>
  Effect.gen(function* fallbackWait() {
    const state = { done: false };
    yield* Effect.forkChild(markDone(state));
    yield* Effect.yieldNow;
    yield* TestClock.adjust('199 millis');
    expect(state.done).toBe(false);
    yield* TestClock.adjust('1 millis');
    expect(state.done).toBe(true);
  }),
);

it.effect('completes on the idle callback when requestIdleCallback is present, capped at its timeout', () =>
  Effect.gen(function* idleWait() {
    const callbacks: (() => void)[] = [];
    const timeouts: number[] = [];
    rstest.stubGlobal('requestIdleCallback', (onIdle: () => void, options: { readonly timeout: number }) => {
      callbacks.push(onIdle);
      timeouts.push(options.timeout);
      return callbacks.length;
    });
    rstest.stubGlobal('cancelIdleCallback', () => null);
    const state = { done: false };
    yield* Effect.forkChild(markDone(state));
    yield* Effect.yieldNow;
    expect(timeouts).toEqual([1000]);
    expect(state.done).toBe(false);
    callbacks[0]?.();
    yield* Effect.yieldNow;
    expect(state.done).toBe(true);
  }),
);

it.effect('cancels its idle callback when interrupted before the browser is idle', () =>
  Effect.gen(function* cancelIdle() {
    const cancelled: number[] = [];
    const callbacks: (() => void)[] = [];
    rstest.stubGlobal('requestIdleCallback', (onIdle: () => void) => {
      callbacks.push(onIdle);
      return 42;
    });
    rstest.stubGlobal('cancelIdleCallback', (handle: number) => {
      cancelled.push(handle);
    });
    const state = { done: false };
    const fiber = yield* Effect.forkChild(markDone(state));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    expect(cancelled).toEqual([42]);
    callbacks[0]?.();
    yield* Effect.yieldNow;
    expect(state.done).toBe(false);
  }),
);

it.effect('cancels its timer when interrupted before the fallback delay', () =>
  Effect.gen(function* cancelTimer() {
    const state = { done: false };
    const fiber = yield* Effect.forkChild(markDone(state));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust('1 second');
    expect(state.done).toBe(false);
  }),
);
