import { expect, it } from 'effect-rstest';
import { confirmedSlow, latencySummary, overBudget } from './mcp.mts';

const LIST = 'tools/list';
const CALL = 'tools/call';

const timings = [
  { method: 'server/discover', ms: 120 },
  { method: LIST, ms: 2001 },
  { method: CALL, ms: 9000 },
  { method: CALL, ms: 10_001 },
  { method: 'other', ms: 60_000 },
];

it('names the slowest miss of each budgeted method and ignores methods without a budget', () => {
  expect(overBudget(timings)).toEqual([
    { budget: 2000, method: LIST, ms: 2001 },
    { budget: 10_000, method: CALL, ms: 10_001 },
  ]);
  expect(overBudget(timings.slice(0, 1))).toEqual([]);
  expect(latencySummary(timings)).toBe(
    `server/discover max 120 ms (1×), ${LIST} max 2001 ms (1×), ${CALL} max 10001 ms (2×), other max 60000 ms (1×)`,
  );
});

it('fails a miss only when its second sample misses too, or could not be taken', () => {
  const misses = overBudget(timings);
  // The call is slow once and fine the second time: only the tool list, judged on its first sample, fails.
  expect(
    confirmedSlow(
      misses,
      new Map([
        [LIST, 800],
        [CALL, 2000],
      ]),
    ),
  ).toEqual([`${LIST} 2001 ms, znovu – ms > 2000 ms`]);
  // A second sample that could not be taken does not excuse the miss.
  expect(confirmedSlow(misses, new Map([[LIST, 800]]))).toEqual([
    `${LIST} 2001 ms, znovu – ms > 2000 ms`,
    `${CALL} 10001 ms, znovu – ms > 10000 ms`,
  ]);
  expect(confirmedSlow(overBudget(timings.filter(({ method }) => method !== LIST)), new Map([[CALL, 2000]]))).toEqual(
    [],
  );
});

it('fails a slow first connect on its one sample, against the real client limit of 5 s', () => {
  const connect = [
    { method: 'connect', ms: 5001 },
    { method: 'server/discover', ms: 90 },
  ];
  const misses = overBudget(connect);
  expect(misses).toEqual([{ budget: 5000, method: 'connect', ms: 5001 }]);
  // The connect is never measured again, so its miss stands.
  expect(confirmedSlow(misses, new Map())).toEqual(['connect 5001 ms, znovu – ms > 5000 ms']);
  expect(overBudget([{ method: 'connect', ms: 4999 }])).toEqual([]);
});
