import { expect } from 'effect-rstest';
import { expect as check } from '@rstest/core';
import { expect as foreign } from 'foreign-assertions';
import assert from 'node:assert';
declare const error: unknown;
expect(error).toEqual(expect.not.objectContaining({ _tag: 'Failure' }));
expect(error).toEqual(expect.not.arrayContaining([{ _tag: 'Some' }, { _tag: 'None' }]));
expect(error).toEqual(expect.not.objectContaining({ payload: { _tag: 'Missing' } }));
expect(error).toEqual(foreign.not.objectContaining({ _tag: 'Missing' }));
expect(error).toEqual(assert.not.objectContaining({ _tag: 'Missing' }));
expect(error).toEqual(expect.not.not.objectContaining({ _tag: 'Missing' }));
expect(error).toEqual(expect.resolves.objectContaining({ _tag: 'Missing' }));
expect(error).toEqual(expect.not.customContaining({ _tag: 'Missing' }));
function shadow(expect: typeof import('effect-rstest').expect) {
  check(error).toEqual(expect.not.objectContaining({ _tag: 'Missing' }));
}
export { shadow };
