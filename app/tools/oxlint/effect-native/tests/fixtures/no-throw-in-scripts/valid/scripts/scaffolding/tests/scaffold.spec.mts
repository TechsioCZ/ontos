/** `*.spec.mts` under scripts is still a test file: throws here never report. */
import { test } from "node:test";

test("scaffold rejects an invalid module id", () => {
	throw new RangeError("expected failure");
});

test("rethrows the original cause", () => {
	try {
		JSON.parse("{");
	} catch (cause) {
		throw cause;
	}
});
