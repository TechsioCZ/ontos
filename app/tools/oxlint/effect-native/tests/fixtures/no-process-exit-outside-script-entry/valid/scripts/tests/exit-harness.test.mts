import assert from "node:assert/strict";

// Test files are out of scope: B2 owns the test harness.
const abortHarness = (): void => {
	process.exit(1);
};

assert.equal(typeof abortHarness, "function");
