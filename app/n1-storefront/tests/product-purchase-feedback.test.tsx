// @rstest-environment happy-dom
import { networkIdle } from "@app/shared-contracts/testing/http-double";
import { rs } from "@rstest/core";
import { afterEach, beforeEach, describe, expect, it } from "effect-rstest";
import { ToastProvider } from "@techsio/ui-kit/molecules/toast";
import { Effect } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductPurchase } from "../src/features/product-purchase";
import { selectProductDetail } from "../src/features/product-selection";
import { CartProvider } from "../src/features/cart-provider";
import { cartStorageKey, decodeStoredCart } from "../src/features/cart-state";
import type { CartEntry } from "../src/features/cart-state";
import type { CheckoutGuardStorage } from "../src/features/checkout-guard";
import { projectCatalog } from "../src/ontos/catalog-model";
import type { ProductDetailModel } from "../src/ontos/catalog-model";
import type { CartScope } from "../src/ontos/cart-quote";
import { getDictionary } from "../src/i18n";

const {
  details: [product],
} = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "market" },
    products: [
      {
        availability: "IN_STOCK",
        currency: "CZK",
        grossPriceMinor: 10_000,
        id: "p1",
        minimumQuantity: 1,
        name: "Owner item",
        slug: "item",
        stockOnHand: 2,
        stockTracked: true,
        unit: "ks",
      },
    ],
  },
  [],
);
const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  marketId: "market",
  tenantId: "70000000-0000-4000-8000-000000000099",
} satisfies CartScope;
const d = getDictionary("cs");
const key = cartStorageKey(scope);
const entry = {
  expectedUnitPriceMinor: 10_000,
  image: null,
  name: product.name,
  productId: product.id,
  quantity: 1,
  sku: "",
  slug: product.slug,
  unit: "ks",
  variantName: "",
} satisfies CartEntry;
let root: Root;
let container: HTMLDivElement;

const seed = (entries: readonly CartEntry[]) => {
  window.localStorage.setItem(key, JSON.stringify({ entries, scope, version: 1 }));
};
const savedEntries = Effect.gen(function* readSavedEntries() {
  const raw = window.localStorage.getItem(key);
  if (raw === null) {
    throw new Error("Expected a persisted cart");
  }
  return (yield* decodeStoredCart(raw, scope)).entries;
});
// The shared barrier drains in-process traffic and its client continuations before count/absence checks.
const flushReact = async () => {
  await act(async () => {});
};
const idle = networkIdle.pipe(Effect.andThen(Effect.promise(flushReact)));
const toastRoots = () =>
  document.querySelectorAll<HTMLElement>('[data-scope="toast"][data-part="root"]');
const purchaseButton = () => {
  const button = [...container.querySelectorAll("button")].find(
    (control) => control.textContent === d.addToCartDetail,
  );
  if (button === undefined) {
    throw new Error("Expected the real purchase button");
  }
  return button;
};
const mount = (
  selected: ProductDetailModel,
  variantId = selected.variants[0]?.id,
  storage: CheckoutGuardStorage = window.localStorage,
) =>
  Effect.gen(function* mountPurchase() {
    yield* Effect.promise(() =>
      act(async () => {
        root.render(
          <ToastProvider>
            <CartProvider imageHosts={[]} scope={scope} storage={storage}>
              <ProductPurchase
                dictionary={d}
                locale="cs"
                product={selected}
                selection={selectProductDetail(selected, variantId)}
              />
            </CartProvider>
          </ToastProvider>,
        );
      }),
    );
    yield* idle;
    // This guidance disappears only after the real cart has restored successfully.
    expect(container.querySelector("#purchase-unavailable")).toBeNull();
    expect(toastRoots()).toHaveLength(0);
  });
const clickPurchase = Effect.gen(function* clickRealPurchase() {
  yield* Effect.promise(() =>
    act(async () => {
      purchaseButton().click();
    }),
  );
  yield* idle;
});
const expectToast = (saved: boolean) =>
  Effect.gen(function* waitForToast() {
    yield* idle;
    yield* Effect.promise(() =>
      rs.waitFor(
        async () => {
          await flushReact();
          expect(toastRoots()).toHaveLength(1);
          const [toast] = toastRoots();
          expect(toast?.dataset.type).toBe(saved ? "success" : "error");
          expect(toast?.querySelector('[data-part="title"]')?.textContent).toBe(
            saved ? d.shopping.added : d.shopping.addFailed,
          );
        },
        { interval: 5, timeout: 3000 },
      ),
    );
    yield* idle;
  });

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.localStorage.clear();
});

describe("product purchase feedback", () => {
  it("leaves the purchase decision pending until the cart has restored", () => {
    const html = renderToStaticMarkup(
      <CartProvider imageHosts={[]} scope={scope}>
        <ProductPurchase
          dictionary={d}
          locale="cs"
          product={product}
          selection={selectProductDetail(product, "unselected")}
        />
      </CartProvider>,
    );
    expect(html).toContain('data-purchase-disabled="pending"');
  });
  it.live.each([
    { disabled: false, name: "priced stock", selected: product },
    { disabled: true, name: "missing price", selected: { ...product, priceMinor: null } },
    { disabled: true, name: "stock below minimum", selected: { ...product, minimumQuantity: 5 } },
    { disabled: true, name: "unknown stock", selected: { ...product, stock: "unknown" } },
    { disabled: true, name: "sold out", selected: { ...product, stock: "unavailable" } },
    {
      disabled: true,
      name: "variant required",
      selected: {
        ...product,
        variants: [{ ...product, attributes: "M", id: "size-m", name: "M" }],
      },
    },
  ] satisfies { disabled: boolean; name: string; selected: ProductDetailModel }[])(
    "publishes the real purchase decision for $name",
    ({ disabled, selected }) =>
      Effect.gen(function* publishedPurchaseDecision() {
        seed([]);
        yield* Effect.promise(() =>
          act(async () => {
            root.render(
              <ToastProvider>
                <CartProvider imageHosts={[]} scope={scope}>
                  <ProductPurchase
                    dictionary={d}
                    locale="cs"
                    product={selected}
                    selection={selectProductDetail(selected, "unselected")}
                  />
                </CartProvider>
              </ToastProvider>,
            );
          }),
        );
        yield* idle;
        const control = container.querySelector<HTMLButtonElement>("[data-purchase-disabled]");
        expect({
          decision: control?.dataset.purchaseDisabled,
          disabled: control?.disabled,
        }).toEqual({ decision: String(disabled), disabled });
      }),
  );
  it.live.each([
    { allowed: false, existing: 0, minimum: 11, stock: 10 },
    { allowed: false, existing: 10, minimum: 1, stock: 10 },
    { allowed: true, existing: 1, minimum: 1, stock: 2 },
  ])(
    "respects stock and already selected quantities: %j",
    ({ allowed, existing, minimum, stock }) =>
      Effect.gen(function* stockPurchase() {
        const initial = existing === 0 ? [] : [{ ...entry, quantity: existing }];
        seed(initial);
        const selected = { ...product, minimumQuantity: minimum, stockQuantity: stock };
        yield* mount(selected);
        expect(yield* savedEntries).toEqual(initial);
        expect(purchaseButton().disabled).toBe(!allowed);
        const before = window.localStorage.getItem(key);
        yield* clickPurchase;
        if (allowed) {
          yield* expectToast(true);
          expect(yield* savedEntries).toEqual([
            expect.objectContaining({ productId: product.id, quantity: existing + minimum }),
          ]);
        } else {
          expect(window.localStorage.getItem(key)).toBe(before);
          expect(toastRoots()).toHaveLength(0);
        }
      }),
  );
  for (const [minimumQuantity, packageQuantity, allowed] of [
    [3, 2, false],
    [4, 2, true],
    [12.42, 6.21, true],
    [12.4, 6.21, false],
  ] as const) {
    it.live(`keeps the native package ${packageQuantity} at minimum ${minimumQuantity}`, () =>
      Effect.gen(function* packagePurchase() {
        seed([]);
        const selected = { ...product, minimumQuantity, packageQuantity, stockQuantity: 100 };
        yield* mount(selected);
        expect(yield* savedEntries).toEqual([]);
        expect(purchaseButton().disabled).toBe(!allowed);
        const before = window.localStorage.getItem(key);
        yield* clickPurchase;
        if (allowed) {
          yield* expectToast(true);
          expect(yield* savedEntries).toEqual([
            expect.objectContaining({ packageQuantity, quantity: minimumQuantity }),
          ]);
        } else {
          expect(window.localStorage.getItem(key)).toBe(before);
          expect(toastRoots()).toHaveLength(0);
        }
      }),
    );
  }
  it.live.each([
    { outcome: "saved", saved: true },
    { outcome: "failed", saved: false },
  ])("announces $outcome cart changes through a toast", ({ saved }) =>
    Effect.gen(function* storageFeedback() {
      seed([]);
      const writes: { key: string; value: string }[] = [];
      const refusedStorage = {
        getItem: (storageKey) => window.localStorage.getItem(storageKey),
        removeItem: (storageKey) => window.localStorage.removeItem(storageKey),
        setItem: (storageKey, value) => {
          writes.push({ key: storageKey, value });
          throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        },
      } satisfies CheckoutGuardStorage;
      yield* mount(product, undefined, saved ? window.localStorage : refusedStorage);
      expect(yield* savedEntries).toEqual([]);
      expect(purchaseButton().disabled).toBe(false);
      expect(container.querySelector('a[href="/cs/kosik"]')).toBeNull();
      expect(container.textContent).not.toContain("neověřen");
      expect(container.querySelector("#purchase-unavailable")).toBeNull();
      const before = window.localStorage.getItem(key);
      yield* clickPurchase;
      yield* expectToast(saved);
      if (saved) {
        expect(yield* savedEntries).toEqual([
          expect.objectContaining({ productId: product.id, quantity: 1 }),
        ]);
      } else {
        expect(writes).toEqual([{ key, value: expect.any(String) }]);
        expect(window.localStorage.getItem(key)).toBe(before);
        expect(yield* savedEntries).toEqual([]);
      }
    }),
  );

  it.live("names the product and leaves the size out of the cart toast", () =>
    Effect.gen(function* variantFeedback() {
      const {
        details: [sized],
      } = projectCatalog(
        {
          market: { configured: true, currency: "CZK", marketId: "market" },
          products: [
            {
              availability: "IN_STOCK",
              currency: "CZK",
              grossPriceMinor: 10_000,
              id: "p2",
              minimumQuantity: 1,
              name: "Owner hoodie – černá",
              slug: "hoodie",
              stockOnHand: 2,
              stockTracked: true,
              unit: "ks",
              variantRecords: [
                {
                  active: true,
                  attributes: "M",
                  availability: "IN_STOCK",
                  grossPriceMinor: 10_000,
                  id: "size-m",
                  minimumQuantity: 1,
                  name: "M",
                  sku: "H-M",
                  stockOnHand: 2,
                  unit: "ks",
                },
              ],
            },
          ],
        },
        [],
      );
      seed([]);
      yield* mount(sized, "size-m");
      expect(yield* savedEntries).toEqual([]);
      expect(purchaseButton().disabled).toBe(false);
      yield* clickPurchase;
      yield* expectToast(true);
      expect(yield* savedEntries).toEqual([
        expect.objectContaining({
          productId: "p2",
          quantity: 1,
          variantId: "size-m",
          variantName: "M",
        }),
      ]);
      expect(toastRoots()[0]?.querySelector('[data-part="description"]')?.textContent).toBe(
        "1 × Owner hoodie – černá",
      );
    }),
  );
});
