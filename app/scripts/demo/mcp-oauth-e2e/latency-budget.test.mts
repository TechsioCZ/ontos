import { expect, it } from 'effect-rstest';
import { confirmedSlow, latencySummary, overBudget } from './mcp.mts';

const LIST = 'tools/list';
const CALL = 'tools/call';

const timings = [
  { method: 'server/discover', ms: 120 },
  { method: LIST, ms: 3001 },
  { method: CALL, ms: 9000 },
  { method: CALL, ms: 10_001 },
  { method: 'other', ms: 60_000 },
];

it('names the slowest miss of each budgeted method and ignores methods without a budget', () => {
  expect(overBudget(timings)).toEqual([
    { budget: 3000, method: LIST, ms: 3001 },
    { budget: 10_000, method: CALL, ms: 10_001 },
  ]);
  expect(overBudget(timings.slice(0, 1))).toEqual([]);
  expect(latencySummary(timings)).toBe(
    `server/discover max 120 ms (1×), ${LIST} max 3001 ms (1×), ${CALL} max 10001 ms (2×), other max 60000 ms (1×)`,
  );
});

it('fails a miss only when its second sample misses too, or could not be taken', () => {
  const misses = overBudget(timings);
  // One slow sample each, both fine the second time: nothing is confirmed.
  expect(
    confirmedSlow(
      misses,
      new Map([
        [LIST, 800],
        [CALL, 2000],
      ]),
    ),
  ).toEqual([]);
  // The list is slow again; the call recovered.
  expect(
    confirmedSlow(
      misses,
      new Map([
        [LIST, 3500],
        [CALL, 2000],
      ]),
    ),
  ).toEqual([`${LIST} 3001 ms, znovu 3500 ms > 3000 ms`]);
  // A second sample that could not be taken does not excuse the miss.
  expect(confirmedSlow(misses, new Map([[LIST, 800]]))).toEqual([`${CALL} 10001 ms, znovu – ms > 10000 ms`]);
});
