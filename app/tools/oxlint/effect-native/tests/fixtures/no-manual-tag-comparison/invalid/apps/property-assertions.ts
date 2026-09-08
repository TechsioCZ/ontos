// expect-count: 16
import { expect } from '@app/effect-rstest';
import * as rstest from '@rstest/core';
import { expect as check } from 'vitest';
import jestExpect from 'expect';
declare const error: unknown;
declare const dynamicTag: string;
const key = '_tag';
const nestedKey = 'cause._tag';
expect(error).toHaveProperty('_tag', 'Missing');
expect(error).toHaveProperty('_tag');
expect(error).not.toHaveProperty('_tag', 'Missing');
expect(error).rejects.toHaveProperty('_tag');
expect(error).toHaveProperty(`_tag`, 'Missing');
expect(error).toHaveProperty('_' + 'tag', 'Missing');
expect(error).toHaveProperty(key, 'Missing');
expect(error).toHaveProperty(['_tag'], 'Missing');
expect(error).toHaveProperty(['cause', '_tag']);
expect(error).toHaveProperty('cause._tag', 'Missing');
expect(error).toHaveProperty(nestedKey, 'Missing');
expect(error)['toHaveProperty']('_tag', dynamicTag);
rstest.expect(error).toHaveProperty(['causes', 0, key], 'Missing');
check(error).toHaveProperty('_tag', 'Missing');
jestExpect(error).toHaveProperty('_tag', 'Missing');
const alias = expect;
function nested(expect: unknown) {
  alias(error).toHaveProperty('_tag', 'Missing');
}
