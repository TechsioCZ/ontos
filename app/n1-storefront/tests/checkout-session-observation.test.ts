import { describe, expect, it } from "@rstest/core";
import { observeCheckoutSession } from "../src/features/checkout-session-observation";
import type { PortalOutcome } from "../src/ontos/portal";

const admitted: Extract<PortalOutcome, { state: "admitted" }> = {
  email: "customer@example.test",
  name: "Test customer",
  state: "admitted",
};

describe("checkout session observations", () => {
  it("keeps fresh anonymous presentation objects stable", () => {
    const first = observeCheckoutSession(null, {
      loaded: true,
      outcome: { state: "anonymous" },
      pending: false,
    });
    expect(
      observeCheckoutSession(first, {
        loaded: true,
        outcome: { state: "anonymous" },
        pending: false,
      }),
    ).toBe(first);
  });

  it("keeps one admitted instance stable during ordinary renders", () => {
    const state = { loaded: true, outcome: admitted, pending: false };
    const first = observeCheckoutSession(null, state);
    expect(observeCheckoutSession(first, { ...state })).toBe(first);
  });

  it("invalidates a quote generation for a new admission with the same email and name", () => {
    const state = { loaded: true, outcome: admitted, pending: false };
    const first = observeCheckoutSession(null, state);
    const nextIdentity = { ...admitted };
    const next = observeCheckoutSession(first, { ...state, outcome: nextIdentity });
    expect(next.key).toBe(first.key);
    expect(next.generation).toBe(first.generation + 1);
    expect(next.identity).toBe(nextIdentity);
  });

  it("does not revive an old generation after A to B to A", () => {
    const state = { loaded: true, outcome: admitted, pending: false };
    const first = observeCheckoutSession(null, state);
    const different = observeCheckoutSession(first, {
      ...state,
      outcome: { ...admitted, email: "another@example.test" },
    });
    const returned = observeCheckoutSession(different, state);
    expect(returned.key).toBe(first.key);
    expect(returned.generation).toBe(first.generation + 2);
  });

  it("fences work across pending authentication and readiness changes", () => {
    const state = { loaded: false, outcome: admitted, pending: false };
    const first = observeCheckoutSession(null, state);
    const ready = observeCheckoutSession(first, { ...state, loaded: true });
    const pending = observeCheckoutSession(ready, { ...state, loaded: true, pending: true });
    const returned = observeCheckoutSession(pending, { ...state, loaded: true });
    expect(returned.generation).toBe(first.generation + 3);
  });
});
