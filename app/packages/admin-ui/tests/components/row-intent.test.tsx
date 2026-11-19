import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Effect, FiberSet } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, expect, it } from 'effect-rstest';

import { makePointerDwell, rowIntentProps } from '../../src/row-intent.ts';

afterEach(cleanup);

const setup = Effect.gen(function* rowIntent() {
  const runFork = yield* FiberSet.makeRuntime();
  const dwell = yield* Effect.acquireRelease(
    Effect.sync(() => makePointerDwell(runFork)),
    (pending) => Effect.sync(pending.cancel),
  );
  const reported: number[] = [];
  const props = rowIntentProps((index) => {
    reported.push(index);
  }, dwell);
  render(
    <>
      <button {...props} data-index="0" type="button">
        First row
      </button>
      <button {...props} data-index="1" type="button">
        Second row
      </button>
    </>,
  );
  return {
    dwell,
    first: screen.getByRole('button', { name: 'First row' }),
    reported,
    second: screen.getByRole('button', { name: 'Second row' }),
  };
});

it.effect('warms only the row the pointer rests on, not the rows it passes over', () =>
  Effect.gen(function* latestPointerRow() {
    const { first, reported, second } = yield* setup;
    fireEvent.pointerOver(first);
    yield* TestClock.adjust('30 millis');
    fireEvent.pointerOver(second);
    yield* TestClock.adjust('59 millis');
    expect(reported).toEqual([]);
    yield* TestClock.adjust('1 millis');
    expect(reported).toEqual([1]);
  }),
);

for (const trigger of ['focus', 'pointerDown'] as const) {
  it.effect(`${trigger} reports immediately and cancels an earlier pointer dwell`, () =>
    Effect.gen(function* immediateIntent() {
      const { first, reported, second } = yield* setup;
      fireEvent.pointerOver(first);
      fireEvent[trigger](second);
      expect(reported).toEqual([1]);
      yield* TestClock.adjust('1 second');
      expect(reported).toEqual([1]);
    }),
  );
}

it.effect('cancelling a pending pointer dwell starts no intent read', () =>
  Effect.gen(function* cancelledDwell() {
    const { dwell, first, reported } = yield* setup;
    fireEvent.pointerOver(first);
    dwell.cancel();
    yield* TestClock.adjust('1 second');
    expect(reported).toEqual([]);
  }),
);
