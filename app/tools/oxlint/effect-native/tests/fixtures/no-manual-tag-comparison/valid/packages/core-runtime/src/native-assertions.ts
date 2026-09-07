import { Predicate, Schema, Exit, Match } from 'effect';
import assert from 'node:assert/strict';
assert.ok(Predicate.isTagged(error, 'Missing'));
assert.equal(Exit.isFailure(exit), true);
assert.ok(Schema.is(Missing)(error));
assert.deepEqual(error, { _tag: 'Missing', message: 'gone' });
assert.fail(`Unexpected failure ${error._tag}`);
expect(Predicate.isTagged(error, 'Missing')).toBe(true);

function unrelatedCallback(equal: (actual: unknown, expected: unknown) => void) {
  equal(error._tag, 'Missing');
}

router.match('/failure', () => log(error._tag));
comparison.equal(error._tag, 'Missing');
function shadowedAssertion(assert: typeof import('node:assert/strict')) {
  assert.equal(error._tag, 'Missing');
}
function shadowedExpectation(expect: (value: unknown) => { toBe: (expected: unknown) => void }) {
  expect(error._tag).toBe('Missing');
}

const readTag = () => error._tag;
assert.strictEqual(readTag, readTag);
assert.equal(log(error._tag), undefined);
