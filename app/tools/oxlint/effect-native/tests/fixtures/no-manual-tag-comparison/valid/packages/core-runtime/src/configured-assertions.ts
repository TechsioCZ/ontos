import assert, { strictEqual as equal } from 'node:assert/strict';
import { expect } from '@rstest/core';
assert.equal(value._tag, 'Legacy');
equal('Legacy', value._tag);
expect(value._tag).not.toEqual('Legacy');
assert.deepEqual(values.map(value => value._tag), ['Legacy']);
