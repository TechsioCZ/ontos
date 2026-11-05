import { describe, expect, it } from "@rstest/core";
import { makeCardVariantIntent } from "../src/features/card-variant-intent";

describe("card variant dismissal and fresh interaction", () => {
  it("keeps one Escape closed when Popover restores the trigger focus", () => {
    const intent = makeCardVariantIntent();
    expect(intent.request("pointer")).toBe(true);
    expect(intent.isActive()).toBe(true);
    intent.dismiss(true);
    expect(intent.request("focus")).toBe(false);
    expect(intent.isActive()).toBe(false);
  });
  it("does not turn click-close focus restoration into a new expansion", () => {
    const intent = makeCardVariantIntent();
    expect(intent.request("activation")).toBe(true);
    intent.dismiss(true);
    expect(intent.request("focus")).toBe(false);
    expect(intent.request("activation")).toBe(true);
    expect(intent.isActive()).toBe(true);
  });
  it("allows genuine keyboard focus after leaving the row and new pointer entry", () => {
    const intent = makeCardVariantIntent();
    intent.request("focus");
    intent.dismiss(true);
    expect(intent.request("focus")).toBe(false);
    intent.leave();
    expect(intent.request("focus")).toBe(true);
    intent.dismiss(true);
    expect(intent.request("pointer")).toBe(true);
  });
  it("does not retain focus suppression after native dismissal to a focusable outside target", () => {
    const intent = makeCardVariantIntent();
    intent.request("activation");
    intent.leave();
    intent.dismiss(false);
    expect(intent.isActive()).toBe(false);
    expect(intent.request("focus")).toBe(true);
  });
  it("cancels delayed expansion when keyboard focus leaves before the response", () => {
    const intent = makeCardVariantIntent();
    intent.request("focus");
    intent.leave();
    expect(intent.isActive()).toBe(false);
    expect(intent.request("focus")).toBe(true);
  });
});
