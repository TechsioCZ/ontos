import { expect, it } from '@app/effect-rstest';
import { Schema } from 'effect';
import { FastCheck } from 'effect/testing';

it.prop(
  'plain tuple properties generate schemas alongside arbitraries',
  [Schema.Literal('schema'), FastCheck.integer({ max: 10, min: 1 })],
  ([label, count]) => {
    expect(label).toBe('schema');
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(10);
  },
  { fastCheck: { numRuns: 20 } },
);

it.prop(
  'plain tuple properties retain FastCheck-only support',
  [FastCheck.constant(7)],
  ([value]) => {
    expect(value).toBe(7);
  },
);
