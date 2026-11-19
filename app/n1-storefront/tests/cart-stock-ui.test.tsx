// @rstest-environment happy-dom
import { setTimeout as nextTurn } from "node:timers/promises";
import { browserNetwork, networkIdle, serveApi } from "@app/shared-contracts/testing/http-double";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CartView } from "../src/features/cart-view";
import { CartProvider } from "../src/features/cart-provider";
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
let stockQuantity = 2;
const handlers = HttpApiBuilder.group(CartQuoteApi, "cartQuote", (group) =>
  group.handle("quote", ({ payload }) =>
    Effect.sync(() => {
      requests.push(payload);
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
const mount = async (locale: "cs" | "en") => {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <CartProvider imageHosts={[]} scope={scope}>
          <CartView dictionary={getDictionary(locale)} locale={locale} />
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
});

describe("cart controls use current owner stock", () => {
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
