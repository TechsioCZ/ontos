// @rstest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { MiniCart } from "../src/features/mini-cart";
import { CartProvider } from "../src/features/cart-provider";
import { cartStorageKey } from "../src/features/cart-state";
import type { CartEntry } from "../src/features/cart-state";
import type { CartScope } from "../src/ontos/cart-quote";
import { getDictionary } from "../src/i18n";

const unexpectedNavigation = () => {
  throw new Error("A closed mini-cart must not navigate");
};
const router = {
  back: unexpectedNavigation,
  bfcacheId: "mini-cart-count",
  forward: unexpectedNavigation,
  prefetch: () => {},
  push: unexpectedNavigation,
  refresh: unexpectedNavigation,
  replace: unexpectedNavigation,
} satisfies AppRouterInstance;
const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "market",
  tenantId: "70000000-0000-4000-8000-000000000099",
} satisfies CartScope;
const foreignScope = { ...scope, marketId: "foreign-market" } satisfies CartScope;
const entry = {
  expectedUnitPriceMinor: 130_700,
  image: null,
  minimumQuantity: 1,
  name: "Owner product",
  productId: "product",
  quantity: 4,
  sku: "SKU-S",
  slug: "owner-product",
  unit: "ks",
  variantId: "size-s",
  variantName: "S",
} satisfies CartEntry;
const savedCart = (entries: readonly CartEntry[], savedScope: CartScope = scope) =>
  JSON.stringify({ entries, scope: savedScope, version: 1 });
const unexpectedOpen = () => {
  throw new Error("The cart must remain closed without a user action");
};
const view = (mode: "scoped" | "unscoped" | "missing-provider" = "scoped") => {
  const miniCart = (
    <MiniCart
      dictionary={getDictionary("cs")}
      locale="cs"
      onOpenChange={unexpectedOpen}
      open={false}
    />
  );
  return (
    <AppRouterContext.Provider value={router}>
      {mode === "missing-provider" ? (
        miniCart
      ) : (
        <CartProvider imageHosts={[]} scope={mode === "scoped" ? scope : null}>
          {miniCart}
        </CartProvider>
      )}
    </AppRouterContext.Provider>
  );
};
let root: Root | null = null;
let container: HTMLDivElement;
const expectNoBadge = () => {
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Košík");
  expect(container.querySelector(".n1-cart-count")).toBeNull();
  expect(container.querySelector('[aria-label="Košík (4)"]')).toBeNull();
  expect([...container.querySelectorAll("span")].some((span) => span.textContent === "4")).toBe(
    false,
  );
};
const mount = async (mode: "scoped" | "missing-provider" = "scoped") => {
  container.replaceChildren(
    document.createRange().createContextualFragment(renderToString(view(mode))),
  );
  // The real server/unloaded state must never leak the previously saved count.
  expectNoBadge();
  await act(async () => {
    root = hydrateRoot(container, view(mode));
  });
};
const externalStorage = async (raw: string | null, savedScope: CartScope = scope) => {
  const key = cartStorageKey(savedScope);
  const oldValue = window.localStorage.getItem(key);
  if (raw === null) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, raw);
  }
  // Browsers deliver this event to the other tab, not to the writer itself.
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: raw,
        oldValue,
        storageArea: window.localStorage,
      }),
    );
  });
};
const expectFour = () => {
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Košík (4)");
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Košík: 4");
  expect(container.querySelector(".n1-cart-count [aria-hidden='true']")?.textContent).toBe("4");
  expect([...container.querySelectorAll("span")].some((span) => span.textContent === "4")).toBe(
    true,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  window.localStorage.clear();
});

describe("historical N1 cart item count", () => {
  it("shows the actual quantity for a single line instead of losing the count in a closed popup", async () => {
    window.localStorage.setItem(cartStorageKey(scope), savedCart([entry]));
    await mount();
    expectFour();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
  it("sums quantities across distinct variants", async () => {
    window.localStorage.setItem(cartStorageKey(scope), savedCart([entry]));
    await mount();
    expectFour();
    await externalStorage(savedCart([entry, { ...entry, quantity: 2, variantId: "size-m" }]));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Košík (6)");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Košík: 6");
    expect(container.querySelector(".n1-cart-count")?.textContent).toBe("6");
  });
  it("caps the visual badge while retaining the full accessible count", async () => {
    window.localStorage.setItem(cartStorageKey(scope), savedCart([entry]));
    await mount();
    expectFour();
    await externalStorage(savedCart([{ ...entry, quantity: 125 }]));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Košík (125)");
    expect(container.querySelector(".n1-cart-count span")?.textContent).toBe("99+");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Košík: 125");
  });
  it("does not show a stale badge for empty, unreadable or foreign-scope carts", async () => {
    window.localStorage.setItem(cartStorageKey(scope), savedCart([entry]));
    await mount("missing-provider");
    expectNoBadge();
    await act(async () => {
      root?.render(view());
    });
    expectFour();
    // An unrelated scope's storage event must not replace this scope's selection.
    await externalStorage(savedCart([{ ...entry, quantity: 9 }], foreignScope), foreignScope);
    expectFour();
    const expectMaskedTransition = async (raw: string | null) => {
      await externalStorage(raw);
      expectNoBadge();
      expect(container.querySelector('[aria-live="polite"]')?.textContent).not.toBe("Košík: 4");
      await externalStorage(savedCart([entry]));
      expectFour();
    };
    await expectMaskedTransition(null);
    await expectMaskedTransition(savedCart([]));
    await expectMaskedTransition("not-json");
    await expectMaskedTransition(savedCart([entry], foreignScope));
    await act(async () => {
      root?.render(view("unscoped"));
    });
    expectNoBadge();
    await act(async () => {
      root?.render(view());
    });
    expectFour();
  });
});
