/** Test files are out of scope (B2 owns the harness; D tier blesses deliberately malformed casts). */
import assert from "node:assert/strict";
import { test } from "node:test";

function decode(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("not an object");
	}
	return value as Record<string, unknown>;
}

test("rejects malformed contracts", () => {
	assert.throws(() => decode("nope" as unknown as object));
	try {
		decode(null);
	} catch (error) {
		throw error;
	}
});
