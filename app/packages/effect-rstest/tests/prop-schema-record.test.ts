import { expect, it } from '@app/effect-rstest';
import { Schema } from 'effect';
import { FastCheck } from 'effect/testing';

it.prop(
  'plain record properties generate schemas alongside arbitraries',
  { count: FastCheck.integer({ max: 10, min: 1 }), label: Schema.Literal('schema') },
  ({ count, label }) => {
    expect(label).toBe('schema');
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(10);
  },
  { fastCheck: { numRuns: 20 } },
);

it.prop(
  'plain record properties retain FastCheck-only support',
  { value: FastCheck.constant(7) },
  ({ value }) => {
    expect(value).toBe(7);
  },
);
