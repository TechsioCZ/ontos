import { Effect, Fiber, Queue } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { LiveChannel, runLiveChanges } from '../../../src/routes/live-changes.ts';
import type { LiveRevalidation, LiveSignal, LiveSource } from '../../../src/routes/live-changes.ts';

class FakeSource implements LiveSource {
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly addEventListener = (type: string, listener: (event: Event) => void) => {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  };
  readonly close = () => {
    this.closed = true;
    this.readyState = 2;
  };
  emit(type: string, data?: string) {
    const event = Object.assign(new Event(type), data === undefined ? {} : { data });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Lets the loop handle queued signals and register its timers before the clock moves. */
const advance = (millis: number) =>
  TestClock.adjust('1 millis').pipe(
    Effect.andThen(TestClock.adjust(millis)),
    Effect.andThen(TestClock.adjust('1 millis')),
  );

const names = (apps: LiveRevalidation) => (apps === 'all' ? apps : [...apps].toSorted());

const startChannel = Effect.gen(function* startChannel() {
  const sources: FakeSource[] = [];
  const revalidations: LiveRevalidation[] = [];
  const signals = yield* Queue.unbounded<LiveSignal>();
  const loop = yield* runLiveChanges(signals).pipe(
    Effect.provideService(LiveChannel, {
      open: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      revalidate: (apps) =>
        Effect.sync(() => {
          revalidations.push(apps);
        }),
    }),
    Effect.forkChild,
  );
  yield* TestClock.adjust('1 millis');
  const source = (index: number) => sources.at(index) ?? new FakeSource();
  return { loop, revalidations, signals, source, sources };
});

it.effect('coalesces pushed changes into one revalidation of the named apps, at most once per second', () =>
  Effect.gen(function* coalesce() {
    const { loop, revalidations, source } = yield* startChannel;
    source(0).emit('open');
    source(0).emit('change', 'crm');
    source(0).emit('change', 'sales-pipeline,crm');
    yield* advance(300);
    expect(revalidations.map(names)).toEqual([['crm', 'sales-pipeline']]);
    source(0).emit('change', 'crm');
    yield* advance(300);
    expect(revalidations).toHaveLength(1);
    yield* advance(700);
    expect(revalidations.map(names)).toEqual([['crm', 'sales-pipeline'], ['crm']]);
    yield* Fiber.interrupt(loop);
    expect(source(0).closed).toBe(true);
  }),
);

it.effect('revalidates everything after a reset, and nothing for a stream the browser resumed by itself', () =>
  Effect.gen(function* resets() {
    const { loop, revalidations, source } = yield* startChannel;
    source(0).emit('open');
    yield* advance(300);
    expect(revalidations).toEqual([]);
    source(0).emit('reset');
    yield* advance(300);
    expect(revalidations).toEqual(['all']);
    // A proxy cut the stream: the browser resumes it with Last-Event-ID and the server covers the gap itself.
    source(0).emit('error');
    source(0).emit('open');
    yield* advance(1000);
    expect(revalidations).toEqual(['all']);
    yield* Fiber.interrupt(loop);
  }),
);

it.effect('closes the stream of a hidden tab and revalidates once when it is shown again', () =>
  Effect.gen(function* hidden() {
    const { loop, revalidations, signals, source, sources } = yield* startChannel;
    source(0).emit('open');
    yield* Queue.offer(signals, { kind: 'hidden' });
    yield* advance(60_000);
    expect(source(0).closed).toBe(true);
    yield* Queue.offer(signals, { kind: 'visible' });
    yield* advance(1);
    expect(sources).toHaveLength(2);
    source(1).emit('open');
    yield* advance(300);
    expect(revalidations).toEqual(['all']);
    yield* Fiber.interrupt(loop);
  }),
);

it.effect('backs off after the server refuses the stream instead of reconnecting at once', () =>
  Effect.gen(function* refused() {
    const { loop, source, sources } = yield* startChannel;
    source(0).readyState = 2;
    source(0).emit('error');
    yield* advance(4000);
    expect(sources).toHaveLength(1);
    yield* advance(1000);
    expect(sources).toHaveLength(2);
    yield* Fiber.interrupt(loop);
  }),
);
