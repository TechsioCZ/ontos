import { expect, it } from 'effect-rstest';
import { formatAxisValue, formatPeriodDay } from '../../src/statistics/format-metric.ts';

it('writes period days in Czech form with a space after each dot', () => {
  expect(formatPeriodDay('2025-11-01')).toBe('1. 11. 2025');
  expect(formatPeriodDay('2026-10-13')).toBe('13. 10. 2026');
});

it('labels only whole ticks on a count axis', () => {
  expect(formatAxisValue(2, 'count')).toBe('2');
  expect(formatAxisValue(1.5, 'count')).toBe('');
  expect(formatAxisValue(0.5, 'pieces')).toBe('');
  expect(formatAxisValue(12.5, 'percent')).toBe('12,5 %');
});
