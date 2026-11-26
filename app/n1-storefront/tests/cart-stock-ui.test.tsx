// @rstest-environment happy-dom
import { setTimeout as nextTurn } from "node:timers/promises";
import { browserNetwork, networkIdle, serveApi } from "@app/shared-contracts/testing/http-double";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CartView } from "../src/features/cart-view";
import { CartProvider, useCart } from "../src/features/cart-provider";
import { MiniCart } from "../src/features/mini-cart";
import { cartStorageKey } from "../src/features/cart-state";
import type { CartEntry } from "../src/features/cart-state";
import { CartQuoteApi, CartQuoteSchemaErrorMiddleware } from "../src/ontos/cart-quote";
import type { CartQuote, CartQuoteRequest, CartScope } from "../src/ontos/cart-quote";
import { getDictionary } from "../src/i18n";

const unexpectedNavigation = () => {
  throw new Error("Stock verification must not navigate without a user action");
};
const router = {
  back: unexpectedNavigation,
  bfcacheId: "cart-stock-ui",
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
// Legacy storage deliberately has no stockQuantity or packageQuantity hint.
const entry = {
  expectedUnitPriceMinor: 10_000,
  image: null,
  minimumQuantity: 1,
  name: "Owner product",
  productId: "product",
  quantity: 2,
  sku: "SKU",
  slug: "product",
  unit: "ks",
  variantId: "size-m",
  variantName: "M",
} satisfies CartEntry;
const quote = {
  issues: [],
  outcome: "VALID",
  scope,
  totalMinor: 20_000,
  totalVatMinor: 3471,
} satisfies CartQuote;
const requests: CartQuoteRequest[] = [];
const quoteGates = new Map<number, Deferred.Deferred<CartQuote>>();
let stockQuantity = 2;
const handlers = HttpApiBuilder.group(CartQuoteApi, "cartQuote", (group) =>
  group.handle("quote", ({ payload }) =>
    Effect.gen(function* cartQuoteResponse() {
      requests.push(payload);
      const gate = quoteGates.get(requests.length);
      if (gate !== undefined) {
        return yield* Deferred.await(gate);
      }
      return {
        ...quote,
        stocks: [{ productId: entry.productId, stockQuantity, variantId: entry.variantId }],
      };
    }),
  ),
).pipe(
  Layer.provide(
    HttpApiMiddleware.layerSchemaErrorTransform(CartQuoteSchemaErrorMiddleware, () =>
      Effect.die("Unexpected invalid cart quote request"),
    ),
  ),
);
const startNetwork = () => ManagedRuntime.make(browserNetwork(serveApi(CartQuoteApi, handlers)));
let network: ReturnType<typeof startNetwork>;
let root: Root;
let container: HTMLDivElement;
const storedCart = JSON.stringify({ entries: [entry], scope, version: 1 });
const SetCartQuantity = () => {
  const cart = useCart();
  return (
    <>
      <button
        onClick={() => {
          cart?.update(entry, 1);
        }}
        type="button"
      >
        Set one
      </button>
      <button
        onClick={() => {
          cart?.update(entry, 2);
        }}
        type="button"
      >
        Set two
      </button>
    </>
  );
};
const mount = async (locale: "cs" | "en", miniOpen = false, showCart = true) => {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <CartProvider imageHosts={[]} locale={locale} scope={scope}>
          <MiniCart
            dictionary={getDictionary(locale)}
            locale={locale}
            onOpenChange={() => {}}
            open={miniOpen}
          />
          {showCart && <CartView dictionary={getDictionary(locale)} locale={locale} />}
          <SetCartQuantity />
        </CartProvider>
      </AppRouterContext.Provider>,
    );
  });
};
const eventually = async (assertion: () => void) => {
  await rs.waitFor(
    async () => {
      await act(async () => {
        await nextTurn(0);
      });
      assertion();
    },
    { interval: 5, timeout: 3000 },
  );
};
const expectQuoteRequest = async (locale: "cs" | "en") => {
  await network.runPromise(networkIdle);
  expect(requests).toEqual([
    {
      lines: [
        {
          expectedUnitPriceMinor: entry.expectedUnitPriceMinor,
          productId: entry.productId,
          quantity: entry.quantity,
          variantId: entry.variantId,
        },
      ],
      locale,
      scope,
    },
  ]);
};

beforeEach(async () => {
  requests.length = 0;
  quoteGates.clear();
  stockQuantity = 2;
  window.localStorage.setItem(cartStorageKey(scope), storedCart);
  network = startNetwork();
  await network.runPromise(Effect.void);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.localStorage.removeItem(cartStorageKey(scope));
  await network.dispose();
  rs.restoreAllMocks();
});

const changeQuantity = async (label: string) => {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)
      ?.click();
  });
};
const miniAmount = (label: string) =>
  [...document.querySelectorAll(".n1-mini-cart-totals dt")].find(
    (term) => term.textContent === label,
  )?.nextElementSibling?.textContent;

describe("cart controls use current owner stock", () => {
  it("retains displayed totals during a stale cart refresh while checkout waits for the response", async () => {
    let now = 1000;
    rs.spyOn(performance, "now").mockImplementation(() => now);
    await mount("cs", false, false);
    await eventually(() => expect(requests).toHaveLength(1));
    await network.runPromise(networkIdle);
    const refreshed = await network.runPromise(Deferred.make<CartQuote>());
    quoteGates.set(2, refreshed);
    now += 31_000;
    await mount("cs", true, false);
    await eventually(() => expect(requests).toHaveLength(2));
    const d = getDictionary("cs");
    expect(miniAmount(d.checkout.total)).toBe("200,00\u00A0Kč");
    expect(miniAmount(d.shopping.net)).toBe("165,29\u00A0Kč");
    expect(miniAmount(d.shopping.vat)).toBe("34,71\u00A0Kč");
    expect(document.querySelector('a[href="/cs/pokladna"]')).toBeNull();
    await act(async () => {
      await network.runPromise(Deferred.succeed(refreshed, quote));
    });
    await eventually(() => {
      expect(miniAmount(d.checkout.total)).toBe("200,00\u00A0Kč");
      expect(document.querySelector('a[href="/cs/pokladna"]')).not.toBeNull();
    });
  });

  it("clears the previous quantity's totals until the new quantity has an owner quote", async () => {
    await mount("cs", true, false);
    const d = getDictionary("cs");
    await eventually(() => expect(miniAmount(d.checkout.total)).toBe("200,00\u00A0Kč"));
    const changed = await network.runPromise(Deferred.make<CartQuote>());
    quoteGates.set(2, changed);
    await changeQuantity("Set one");
    await eventually(() =>
      expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2, 1]),
    );
    expect(miniAmount(d.checkout.total)).toBe(d.shopping.unresolved);
    expect(miniAmount(d.shopping.net)).toBe(d.shopping.unresolved);
    expect(miniAmount(d.shopping.vat)).toBe(d.shopping.unresolved);
    expect(document.querySelector('a[href="/cs/pokladna"]')).toBeNull();
    await act(async () => {
      await network.runPromise(
        Deferred.succeed(changed, { ...quote, totalMinor: 10_000, totalVatMinor: 1736 }),
      );
    });
    await eventually(() => expect(miniAmount(d.checkout.total)).toBe("100,00\u00A0Kč"));
  });

  it("does not replace newer quantity totals with a late response for the previous selection", async () => {
    const previous = await network.runPromise(Deferred.make<CartQuote>());
    const current = await network.runPromise(Deferred.make<CartQuote>());
    quoteGates.set(1, previous);
    quoteGates.set(2, current);
    await mount("cs", true, false);
    await eventually(() => expect(requests).toHaveLength(1));
    await changeQuantity("Set one");
    await eventually(() =>
      expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2, 1]),
    );
    await act(async () => {
      await network.runPromise(
        Deferred.succeed(current, { ...quote, totalMinor: 10_000, totalVatMinor: 1736 }),
      );
    });
    const d = getDictionary("cs");
    await eventually(() => expect(miniAmount(d.checkout.total)).toBe("100,00\u00A0Kč"));
    await act(async () => {
      await network.runPromise(Deferred.succeed(previous, quote));
      await network.runPromise(networkIdle);
    });
    expect(miniAmount(d.checkout.total)).toBe("100,00\u00A0Kč");
    expect(miniAmount(d.shopping.net)).toBe("82,64\u00A0Kč");
    expect(miniAmount(d.shopping.vat)).toBe("17,36\u00A0Kč");
    expect(document.querySelector('a[href="/cs/pokladna"]')).not.toBeNull();
  });

  it.each(["cs", "en"] as const)(
    "bounds a legacy hintless cart and disables increment at max in %s",
    async (locale) => {
      await mount(locale);
      await eventually(() => {
        const input = container.querySelector('input[role="spinbutton"]');
        expect(input?.getAttribute("aria-valuemax")).toBe("2");
        expect(input?.getAttribute("aria-valuenow")).toBe("2");
        const increment = container.querySelector<HTMLButtonElement>(
          'button[data-part="increment-trigger"]',
        );
        expect(increment?.disabled).toBe(true);
        expect(container.querySelector(`a[href="/${locale}/pokladna"]`)).not.toBeNull();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[data-part="increment-trigger"]')
          ?.click();
      });
      await expectQuoteRequest(locale);
      expect(window.localStorage.getItem(cartStorageKey(scope))).toBe(storedCart);
      expect(
        container.querySelector('input[role="spinbutton"]')?.getAttribute("aria-valuenow"),
      ).toBe("2");
    },
  );
  it("warms a saved cart before opening and coalesces background quantity changes", async () => {
    await mount("cs", false, false);
    await eventually(() => expect(requests).toHaveLength(1));
    await network.runPromise(networkIdle);
    await mount("cs", true, false);
    await eventually(() => {
      expect(document.body.querySelectorAll('a[href="/cs/pokladna"]')).toHaveLength(1);
    });
    await expectQuoteRequest("cs");
    await mount("cs", false, false);
    await changeQuantity("Set one");
    await changeQuantity("Set two");
    await act(async () => {
      await nextTurn(250);
    });
    await network.runPromise(networkIdle);
    expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2, 2]);
  });

  it("shares one quote with the mini-cart and reuses it on reopen", async () => {
    await mount("cs", true);
    await eventually(() => {
      expect(document.body.querySelectorAll('a[href="/cs/pokladna"]')).toHaveLength(2);
    });
    await expectQuoteRequest("cs");
    await mount("cs", false, false);
    await mount("cs", true, false);
    await eventually(() => {
      expect(document.body.querySelectorAll('a[href="/cs/pokladna"]')).toHaveLength(1);
    });
    await expectQuoteRequest("cs");
  });

  it("quotes a new quantity even when the cart returns to a previous selection", async () => {
    await mount("cs");
    await eventually(() =>
      expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2]),
    );
    await changeQuantity("Set one");
    await eventually(() =>
      expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2, 1]),
    );
    await changeQuantity("Set two");
    await eventually(() =>
      expect(requests.map((request) => request.lines[0]?.quantity)).toEqual([2, 1, 2]),
    );
  });

  it("blocks checkout when fresh catalog stock falls below the saved quantity", async () => {
    stockQuantity = 1;
    await mount("cs");
    await eventually(() => {
      expect(
        container.querySelector('input[role="spinbutton"]')?.getAttribute("aria-valuemax"),
      ).toBe("1");
    });
    // Await the actual response and its rendered stock bound before checking absence:
    // a pending quote would also lack the checkout link, without proving this guard.
    await expectQuoteRequest("cs");
    expect(container.querySelector('a[href="/cs/pokladna"]')).toBeNull();
    const checkout = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === getDictionary("cs").shopping.checkout,
    );
    expect(checkout?.disabled).toBe(true);
    expect(window.localStorage.getItem(cartStorageKey(scope))).toBe(storedCart);
  });
});
