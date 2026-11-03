import { describe, expect, it } from "@rstest/core";
import { changeHeaderPanel, miniCartState } from "../src/features/header-panel-state";

const scope = {
  currency: "CZK" as const,
  legalEntityId: "seller",
  marketId: "market",
  tenantId: "tenant",
};
describe("N1 header popovers", () => {
  it("opens the requested panel and ignores a delayed outside-close from the previous panel", () => {
    const login = changeHeaderPanel(null, "login", true);
    const cart = changeHeaderPanel(login, "cart", true);
    expect(changeHeaderPanel(cart, "login", false)).toBe("cart");
    expect(changeHeaderPanel(cart, "cart", false)).toBeNull();
    const navigation = changeHeaderPanel(cart, "navigation", true);
    expect(changeHeaderPanel(navigation, "cart", false)).toBe("navigation");
    expect(changeHeaderPanel(navigation, "login", true)).toBe("login");
  });
  it("never calls an unavailable or unreadable cart empty", () => {
    expect(miniCartState(null)).toBe("unavailable");
    expect(miniCartState({ entries: [], error: false, loaded: true, scope: null })).toBe(
      "unavailable",
    );
    expect(miniCartState({ entries: [], error: true, loaded: true, scope })).toBe("error");
    expect(miniCartState({ entries: [], error: false, loaded: false, scope })).toBe("loading");
    expect(miniCartState({ entries: [], error: false, loaded: true, scope })).toBe("empty");
  });
});
