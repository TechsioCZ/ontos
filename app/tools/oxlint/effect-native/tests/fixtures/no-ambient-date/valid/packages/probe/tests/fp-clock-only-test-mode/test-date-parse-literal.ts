// FALSE POSITIVE repro (testMode: "clock-only").
//
// Real hits this reproduces:
//   packages/core-runtime/tests/unit/action-authorization-rollout.test.ts:6,8,10
//   packages/core-runtime/tests/unit/action-permission.test.ts:225
//   scripts/tests/authorization-rollout-contract.test.mts:18,39,50
//   scripts/tests/check-authorization-readiness.test.mts:102
//   scripts/tests/plan-deployment-impact.test.mts:461,525,538
//
// `Date.parse("<literal>")` is a pure, deterministic function of a frozen string. It reads no
// ambient clock, so `TestClock` has nothing to own and the test can never be flaky or slow because
// of it (audit B2 is about "real sleeps/timers"). It is the exact same construct as
// `new Date("<literal>")`, which the rule deliberately allows in clock-only mode -- see
// `valid/test-fixture-instants.ts` and the rule header ("Frozen fixture instants ... stay legal").
// Reporting one and not the other is self-contradictory.
//
// Evidence of the inconsistency in the repo: outbox-runtime.test.ts:162/167/173/223/249 all use
// `new Date("2026-08-03T10:00:00Z")` and are NOT reported, while the literal `Date.parse` sites
// above ARE.

// Allowed today: frozen fixture instant.
export const windowStart = new Date("2026-09-01T00:00:00.000Z");

// Reported today, but identical in kind: frozen fixture instant.
export const windowStartEpochMs = Date.parse("2026-09-01T00:00:00.000Z");

export const contract = {
  activatedAtEpochMs: Date.parse("2026-09-01T00:00:00.000Z"),
  expiresAtEpochMs: Date.parse("2026-10-01T00:00:00.000Z"),
};

// Also reported today: parsing a field of a frozen fixture, still fully deterministic.
const fixture = { expiresAt: "2026-10-01T00:00:00.000Z" };
export const expiryEpochMs = Date.parse(fixture.expiresAt);
