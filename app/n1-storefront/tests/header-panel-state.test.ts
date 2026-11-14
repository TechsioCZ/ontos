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
  it("coordinates desktop categories with cart, login and mobile navigation", () => {
    const categories = changeHeaderPanel("cart", "categories", true);
    expect(categories).toBe("categories");
    expect(changeHeaderPanel(categories, "cart", false)).toBe("categories");
    const login = changeHeaderPanel(categories, "login", true);
    expect(changeHeaderPanel(login, "categories", false)).toBe("login");
    const mobile = changeHeaderPanel(categories, "navigation", true);
    expect(changeHeaderPanel(mobile, "categories", false)).toBe("navigation");
    expect(changeHeaderPanel(categories, "categories", false)).toBeNull();
  });
});
