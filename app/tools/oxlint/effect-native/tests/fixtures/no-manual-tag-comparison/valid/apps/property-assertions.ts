import { expect } from 'effect-rstest';
import { expect as foreignExpect } from 'foreign-assertions';
import * as assert from 'node:assert';
declare const error: unknown;
declare const dynamicPath: string;
declare const foreign: typeof expect;
const failure = 'Failure';
expect(error).toHaveProperty('_tag', 'Failure');
expect(error).toHaveProperty('cause._tag', failure);
expect(error).toHaveProperty(['cause', '_tag'], 'Success');
expect(error).toHaveProperty('tag', 'Missing');
expect(error).toHaveProperty('_tags', 'Missing');
expect(error).toHaveProperty('cause.not_tag', 'Missing');
expect(error).toHaveProperty('cause._tagSuffix');
expect(error).toHaveProperty(['cause._tag'], 'Missing');
expect(error).toHaveProperty(dynamicPath, 'Missing');
expect(error).toHaveProperty([], 'Missing');
expect(error).toHaveProperty(['cause', dynamicPath], 'Missing');
expect(error).toHaveProperty('message', { _tag: 'Missing' });
foreignExpect(error).toHaveProperty('_tag', 'Missing');
function shadowed(expect: typeof foreign) {
  expect(error).toHaveProperty('_tag', 'Missing');
}
let mutable = expect;
mutable = foreign;
mutable(error).toHaveProperty('_tag', 'Missing');
let key = '_tag';
key = 'message';
expect(error).toHaveProperty(key, 'Missing');
assert.toHaveProperty(error, '_tag', 'Missing');
const ordinary = { toHaveProperty: (...args: unknown[]) => args };
ordinary.toHaveProperty('_tag', 'Missing');
function shadowedKey() {
  const key = 'message';
  expect(error).toHaveProperty(key, 'Missing');
}
expect(error).toHaveProperty('_tag.length', 7);
expect(error).toHaveProperty(['_tag', 'length'], 7);
