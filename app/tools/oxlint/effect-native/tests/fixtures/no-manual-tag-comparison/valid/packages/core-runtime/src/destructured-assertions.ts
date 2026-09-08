import assert from 'node:assert/strict';
import { expect } from 'effect-rstest';
import foreign from 'foreign-assertions';
declare const error: { _tag: string };
const { strictEqual: foreignEqual } = foreign;
foreignEqual(error._tag, 'Missing');
function shadow(assert: typeof import('node:assert/strict')) {
  const { strictEqual } = assert;
  strictEqual(error._tag, 'Missing');
}
let { strictEqual: mutable } = assert;
mutable = foreignEqual;
mutable(error._tag, 'Missing');
const { strictEqual: adt } = assert;
adt(error._tag, 'Failure');
const { strictEqual: ordinary } = assert;
ordinary(error, error);
const { strictEqual: defaulted = foreignEqual } = assert;
defaulted(error._tag, 'Missing');
const fixture = { _tag: 'Missing' };
expect(error).toMatchObject({ message: 'Missing' });
expect(error).toMatchObject({ _tag: 'Failure' });
foreign(error).toMatchObject(fixture);
function shadowExpect(expect: typeof import('effect-rstest').expect) {
  expect(error).toMatchObject({ _tag: 'Missing' });
}
export { shadow, shadowExpect };

const field = '_tag';
expect(error).toMatchObject({ field: 'Missing' });

expect(error).toEqual({ message: 'Missing' });
expect(error).toStrictEqual({ _tag: 'Failure' });
expect(error).toEqual({ field: 'Missing' });
expect([error]).toContainEqual({ _tag: 'Some' });
assert.deepEqual(error, { message: 'Missing' });
assert.deepStrictEqual(error, { _tag: 'Failure' });
assert.notDeepEqual(error, { field: 'Missing' });
assert.notDeepStrictEqual(error, { _tag: 'None' });
foreign(error).toEqual(fixture);
function shadowObjectExpect(expect: typeof import('effect-rstest').expect) {
  expect(error).toStrictEqual({ _tag: 'Missing' });
}
export { shadowObjectExpect };
