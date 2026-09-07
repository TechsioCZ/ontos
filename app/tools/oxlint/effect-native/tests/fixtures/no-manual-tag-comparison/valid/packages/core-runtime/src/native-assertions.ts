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
