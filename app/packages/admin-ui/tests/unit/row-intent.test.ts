import { expect, it } from 'effect-rstest';

import { makeIntentLimiter } from '../../src/row-intent.ts';

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
