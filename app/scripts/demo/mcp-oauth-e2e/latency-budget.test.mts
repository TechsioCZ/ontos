import { expect, it } from 'effect-rstest';
import { latencySummary, overBudget } from './mcp.mts';

it('fails a slow authenticated discovery, list or call, and ignores methods without a budget', () => {
  const timings = [
    { method: 'server/discover', ms: 120 },
    { method: 'tools/list', ms: 3001 },
    { method: 'tools/call', ms: 9000 },
    { method: 'tools/call', ms: 10_001 },
    { method: 'other', ms: 60_000 },
  ];
  expect(overBudget(timings)).toEqual(['tools/list 3001 ms > 3000 ms', 'tools/call 10001 ms > 10000 ms']);
  expect(overBudget(timings.slice(0, 1))).toEqual([]);
  expect(latencySummary(timings)).toBe(
    'server/discover max 120 ms (1×), tools/list max 3001 ms (1×), tools/call max 10001 ms (2×), other max 60000 ms (1×)',
  );
});
