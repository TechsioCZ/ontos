// expect-count: 17
import assert, { strictEqual as equal } from 'node:assert/strict';
import { expect, expect as check } from '@rstest/core';
import * as testing from '@rstest/core';
import * as assertions from 'node:assert/strict';
import { strict as strictAssert } from 'node:assert';
assert.equal(error._tag, 'Missing');
assert.strictEqual(error['_tag'], expected);
assert.deepEqual(errors.map(error => error._tag), ['Missing']);
const tags = errors.map(error => error._tag);
assert.deepEqual(tags, ['Missing']);
expect(error._tag).toBe('Missing');
expect(error._tag).not.toEqual('Missing');
expect(error._tag).resolves.toStrictEqual('Missing');
assert.equal(error._tag, 'Missing', 'Some');
expect(error._tag).toBe('Missing', 'Some');
assert.equal(guard && failure._tag, 'Missing');

equal(error._tag, 'Missing');
const same = assert.strictEqual;
same(error._tag, 'Missing');
const equalAgain = equal;
equalAgain(error._tag, 'Missing');

assertions.deepStrictEqual(error._tag, 'Missing');
strictAssert.equal(error._tag, 'Missing');
check(error._tag).not.toBe('Missing');
testing.expect(error._tag).toEqual('Missing');
