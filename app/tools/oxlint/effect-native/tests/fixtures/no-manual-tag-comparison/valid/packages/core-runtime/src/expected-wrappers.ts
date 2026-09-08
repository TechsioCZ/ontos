import { expect } from 'effect-rstest';
import { expect as check } from '@rstest/core';
import { expect as foreign } from 'foreign-assertions';
import assert from 'node:assert';
declare const error: unknown;
expect(error).toEqual(expect.objectContaining({ _tag: 'Failure' }));
expect(error).toEqual(expect.arrayContaining([{ _tag: 'Some' }, { _tag: 'None' }]));
expect(error).toEqual(expect.arrayContaining([expect.objectContaining({ _tag: 'Left' })]));
expect(error).toEqual(expect.objectContaining({ payload: { _tag: 'Missing' } }));
expect(error).toEqual(expect.objectContaining({ payload: expect.objectContaining({ _tag: 'Missing' }) }));
expect(error).toEqual(expect.arrayContaining([{ payload: { _tag: 'Missing' } }]));
expect(error).toEqual([{ _tag: 'Missing' }]);
expect(error).toEqual(expect.objectContaining([{ _tag: 'Missing' }]));
expect(error).toEqual(expect.arrayContaining({ _tag: 'Missing' }));
expect(error).toEqual(foreign.objectContaining({ _tag: 'Missing' }));
expect(error).toEqual(assert.objectContaining({ _tag: 'Missing' }));
const fake = { objectContaining: (value: unknown) => value };
expect(error).toEqual(fake.objectContaining({ _tag: 'Missing' }));
function shadow(expect: typeof import('effect-rstest').expect) {
  check(error).toEqual(expect.objectContaining({ _tag: 'Missing' }));
}
function shadowHelper(objectContaining: (value: unknown) => unknown) {
  expect(error).toEqual(objectContaining({ _tag: 'Missing' }));
}
let helper = expect.objectContaining;
helper = fake.objectContaining;
expect(error).toEqual(helper({ _tag: 'Missing' }));
let mutableExpect = expect;
mutableExpect = foreign;
expect(error).toEqual(mutableExpect.objectContaining({ _tag: 'Missing' }));
const cycle = other;
const other = cycle;
expect(error).toEqual(expect.arrayContaining(cycle));
const recursive = [recursive];
expect(error).toEqual(expect.arrayContaining(recursive));
expect(error).toEqual(expect.objectContaining());
expect(error).toEqual(expect.arrayContaining([]));
export { shadow, shadowHelper };

expect(error).toEqual(expect.customContaining({ _tag: 'Missing' }));
expect(error).toEqual(expect(error).objectContaining({ _tag: 'Missing' }));
