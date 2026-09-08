// expect-count: 10
import assert from 'node:assert/strict';
import { expect } from 'effect-rstest';
declare const error: unknown;
declare const tag: string;
expect(error).toEqual({ _tag: 'Missing', reason: 'denied' });
expect(error).not.toStrictEqual({ ['_tag']: 'Missing' });
expect([error]).toContainEqual({ _tag: 'Missing' });
const expected = { _tag: tag };
expect(error).toEqual(expected);
assert.deepEqual(error, { _tag: 'Missing' });
assert.deepStrictEqual(error, { _tag: 'Missing' });
assert.notDeepEqual(error, { _tag: 'Missing' });
assert.notDeepStrictEqual(error, { _tag: 'Missing' });
const { deepStrictEqual: equalShape } = assert;
equalShape(error, expected);
expect(error).rejects.toStrictEqual({ _tag: 'Missing' });
