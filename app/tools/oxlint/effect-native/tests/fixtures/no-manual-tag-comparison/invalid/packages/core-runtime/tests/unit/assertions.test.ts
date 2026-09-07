// expect-count: 12
import assert, { strictEqual as equal } from 'node:assert/strict';
import { expect } from '@rstest/core';
assert.equal(error._tag, 'Missing');
assert.strictEqual(error['_tag'], expected);
assert.deepEqual(errors.map(error => error._tag), ['Missing']);
const tags = errors.map(error => error._tag);
assert.deepEqual(tags, ['Missing']);
expect(error._tag).toBe('Missing');
expect(error._tag).not.toEqual('Missing');
expect(error._tag).resolves.toStrictEqual('Missing');
assert.equal(option._tag, 'Some');
assert.equal(guard && failure._tag, 'Missing');

equal(error._tag, 'Missing');
const same = assert.strictEqual;
same(error._tag, 'Missing');
const equalAgain = equal;
equalAgain(error._tag, 'Missing');
