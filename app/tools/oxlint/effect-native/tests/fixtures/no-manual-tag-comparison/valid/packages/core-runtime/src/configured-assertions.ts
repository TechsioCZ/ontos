import assert, { strictEqual as equal } from 'node:assert/strict';
import { expect } from '@rstest/core';
assert.equal(value._tag, 'Legacy');
equal('Legacy', value._tag);
expect(value._tag).not.toEqual('Legacy');
assert.deepEqual(values.map(value => value._tag), ['Legacy']);

switch (value._tag) {
  case 'Legacy': break;
  default: break;
}

expect(value).toEqual(expect.objectContaining({ _tag: 'Legacy' }));
expect(value).toEqual(expect.arrayContaining([{ _tag: 'Legacy' }, { _tag: 'Failure' }]));
