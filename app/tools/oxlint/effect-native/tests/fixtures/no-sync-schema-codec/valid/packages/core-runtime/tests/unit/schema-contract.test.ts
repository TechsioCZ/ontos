// Tests are ignored by default: proving rejection with a throwing decoder is the deliberate,
// audit-blessed shape ("deliberately malformed casts in tests", "tests decode through Schema").
import assert from 'node:assert/strict';
import { Schema } from 'effect';

const IcoSchema = Schema.String;

assert.equal(Schema.decodeUnknownSync(IcoSchema)('00123456'), '00123456');
assert.throws(() => Schema.decodeUnknownSync(IcoSchema)(42));
assert.equal(Schema.encodeSync(IcoSchema)('00123456'), '00123456');

/** `JSON.stringify` inside an external test-fixture API that requires a body string. */
export const fixtureResponse = (body: unknown): Response => new Response(JSON.stringify(body));
