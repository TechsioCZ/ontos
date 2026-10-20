import { expect, it } from 'effect-rstest';
import { formatCzechDays } from '../../src/czech-plural.ts';

it('formats Czech day counts using cardinal rules, not the final digit', () => {
  for (const [count, expected] of [
    [0, '0 dní'],
    [1, '1 den'],
    [2, '2 dny'],
    [3, '3 dny'],
    [4, '4 dny'],
    [5, '5 dní'],
    [11, '11 dní'],
    [14, '14 dní'],
    [21, '21 dní'],
    [22, '22 dní'],
    [101, '101 dní'],
    [-1, '-1 den'],
    [1.5, '1,5 dne'],
  ] as const) {
    expect(formatCzechDays(count)).toBe(expected);
  }
});
