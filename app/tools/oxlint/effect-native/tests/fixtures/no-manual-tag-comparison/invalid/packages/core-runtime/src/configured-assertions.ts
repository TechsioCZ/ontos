// expect-count: 4
import assert from 'node:assert/strict';
import { expect } from '@rstest/core';
assert.equal(value._tag, 'Missing', 'Legacy');
expect(value._tag).toBe('Missing', 'Legacy');
assert.deepEqual(values.map(value => value._tag), ['Legacy', 'Missing']);

switch (value._tag) {
  case 'Legacy': break;
  case 'Missing': break;
}
