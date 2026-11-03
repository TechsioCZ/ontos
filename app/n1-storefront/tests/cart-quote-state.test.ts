import { describe, expect, it } from "effect-rstest";
import {
  advanceQuoteSelection,
  isCurrentQuoteSnapshot,
  quoteFailureState,
} from "../src/features/cart-quote-state";

describe("quote request generation", () => {
  it("keeps an obsolete market distinct from temporary transport unavailability", () => {
    expect(quoteFailureState({ _tag: "CartQuoteScopeProblem", state: "scope-mismatch" })).toBe(
      "scope-mismatch",
    );
    expect(quoteFailureState({ _tag: "CartQuoteUnavailableProblem" })).toBe("unavailable");
  });
  it("never revives a verified A snapshot after A to B to A", () => {
    const a = { generation: 0, key: "A" };
    const old = { ...a, attempt: 1 };
    const b = advanceQuoteSelection(a, "B");
    const again = advanceQuoteSelection(b, "A");
    expect(isCurrentQuoteSnapshot(old, again, 1)).toBe(false);
    expect(isCurrentQuoteSnapshot({ ...again, attempt: 1 }, again, 1)).toBe(true);
  });
  it("invalidates on an incomplete draft, even when it returns to the same quantity", () => {
    const a = { generation: 0, key: "A" };
    const old = { ...a, attempt: 1 };
    const incomplete = advanceQuoteSelection(a, null);
    const again = advanceQuoteSelection(incomplete, "A");
    expect(isCurrentQuoteSnapshot(old, incomplete, 1)).toBe(false);
    expect(isCurrentQuoteSnapshot(old, again, 1)).toBe(false);
    expect(isCurrentQuoteSnapshot({ ...again, attempt: 1 }, again, 2)).toBe(false);
  });
});
