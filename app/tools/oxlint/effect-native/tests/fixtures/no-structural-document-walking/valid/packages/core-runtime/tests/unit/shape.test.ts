import assert from 'node:assert/strict';

const result: Record<string, unknown> = { id: 'x' };

/** Shape-proving assertions are D tier; tests are out of scope by default. */
assert.equal(Object.hasOwn(result, 'providerKeyId'), false);
assert.equal('secret' in result, false);
assert.equal(typeof result['id'] === 'string', true);
