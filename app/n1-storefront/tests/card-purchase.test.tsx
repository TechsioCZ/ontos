// @rstest-environment happy-dom
import { browserNetwork, networkIdle } from "@app/shared-contracts/testing/http-double";
import { HttpRouter, HttpServerResponse } from "@modern-js/bff-effect/effect-edge";
import { ToastProvider } from "@techsio/ui-kit/molecules/toast";
import { act, useLayoutEffect } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "effect-rstest";
import { CardPurchase } from "../src/features/card-purchase";
import { simpleCardEntry } from "../src/features/card-purchase-model";
import { CartProvider } from "../src/features/cart-provider";
import type { useCart } from "../src/features/cart-provider";
import { addCartEntry, cartStorageKey, decodeStoredCart } from "../src/features/cart-state";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import type { ProductCardModel } from "../src/ontos/catalog-model";

const product: ProductCardModel = {
  currency: "CZK",
  description: "",
  id: "product",
  image: null,
  minimumQuantity: 3,
  name: "Owner cable",
  priceFrom: false,
  priceMinor: 1290,
  sku: "CABLE",
  slug: "owner-cable",
  stock: "available",
  unit: "m",
  variantCount: 0,
  variantPreview: [],
};
const scope = {
  currency: "CZK",
  legalEntityId: "11111111-1111-4111-8111-111111111111",
  marketId: "market",
  tenantId: "22222222-2222-4222-8222-222222222222",
} as const;
const cartState = (
  overrides: Partial<NonNullable<ReturnType<typeof useCart>>> = {},
): NonNullable<ReturnType<typeof useCart>> => ({
  acceptPrice: () => false,
  add: () => true,
  clear: () => {},
  clearSubmitted: () => false,
  entries: [],
  error: false,
  imageHosts: [],
  loaded: true,
  remove: () => false,
  scope,
  update: () => false,
  ...overrides,
});
const d = getDictionary("cs");
let container: HTMLDivElement;
let root: Root;
const requests: string[] = [];
const cardNetwork = browserNetwork(
  HttpRouter.add("*", "/*", (request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpServerResponse.jsonUnsafe(
        { error: "Card purchase must not eagerly read the owner" },
        { status: 500 },
      );
    }),
  ),
);
const purchaseButton = () => {
  const button = container.querySelector("button");
  if (button === null) {
    throw new Error("Missing real card purchase button");
  }
  return button;
};
const toasts = () => [
  ...document.querySelectorAll<HTMLElement>('[data-scope="toast"][data-part="root"]'),
];
const storedEntries = () =>
  Effect.gen(function* readPersistedEntries() {
    const raw = window.localStorage.getItem(cartStorageKey(scope));
    if (raw === null) {
      throw new Error("Cart purchase was not persisted");
    }
    const cart = yield* decodeStoredCart(raw, scope);
    return cart.entries;
  });
// Layout effects observe the actual first render before CartProvider restores storage in its passive effect.
const BeforeRestore = ({ observe }: { observe: () => void }) => {
  useLayoutEffect(observe, [observe]);
  return null;
};
const mount = async ({
  beforeRestore,
  presentation = "featured",
  storage,
}: {
  beforeRestore?: (() => void) | undefined;
  presentation?: ComponentProps<typeof CardPurchase>["presentation"];
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
} = {}) => {
  await act(async () => {
    root.render(
      <ToastProvider>
        <CartProvider imageHosts={[]} scope={scope} {...(storage === undefined ? {} : { storage })}>
          <CardPurchase dictionary={d} presentation={presentation} product={product} />
          {beforeRestore === undefined ? null : <BeforeRestore observe={beforeRestore} />}
        </CartProvider>
      </ToastProvider>,
    );
  });
};
const idle = Effect.gen(function* settleCardNetwork() {
  yield* networkIdle;
  yield* Effect.promise(() => act(async () => {}));
  expect(requests).toEqual([]);
});
const clickPurchase = Effect.promise(() =>
  act(async () => {
    purchaseButton().click();
  }),
);
beforeEach(() => {
  requests.length = 0;
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

const registerSaveResult = (saved: boolean) => {
  it.live(`announces only the actual ${saved ? "saved" : "failed"} cart result`, () =>
    Effect.gen(function* announceSaveResult() {
      const writes: { key: string; value: string }[] = [];
      yield* Effect.promise(() =>
        mount({
          storage: saved
            ? undefined
            : {
                getItem: (key) => window.localStorage.getItem(key),
                removeItem: (key) => window.localStorage.removeItem(key),
                setItem: (key, value) => {
                  writes.push({ key, value });
                  throw new DOMException("Cart storage quota exhausted", "QuotaExceededError");
                },
              },
        }),
      );
      expect(purchaseButton().disabled).toBe(false);
      expect(container.querySelector("a[href]")).toBeNull();
      yield* clickPurchase;
      yield* idle;
      const notifications = toasts();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.dataset.type).toBe(saved ? "success" : "error");
      expect(notifications[0]?.querySelector('[data-part="title"]')?.textContent).toBe(
        saved ? d.shopping.added : d.shopping.addFailed,
      );
      expect(notifications[0]?.querySelector('[data-part="description"]')?.textContent).toBe(
        saved ? "3 × Owner cable" : undefined,
      );
      if (saved) {
        expect(yield* storedEntries()).toEqual([
          expect.objectContaining({ quantity: 3, unit: "m" }),
        ]);
      } else {
        expect(writes).toHaveLength(1);
        expect(writes[0]?.key).toBe(cartStorageKey(scope));
        const attempted = yield* decodeStoredCart(writes[0]?.value ?? "", scope);
        expect(attempted.entries).toEqual([expect.objectContaining({ quantity: 3, unit: "m" })]);
        expect(window.localStorage.getItem(cartStorageKey(scope))).toBeNull();
      }
    }).pipe(Effect.provide(cardNetwork)),
  );
};

describe("simple card purchase uses real native values", () => {
  it("disables a card when its minimum would exceed stock or the existing cart allocation", () => {
    const limited = { ...product, minimumQuantity: 1, stockQuantity: 2 };
    const entry = simpleCardEntry(limited, cartState());
    expect(entry).toMatchObject({ quantity: 1, stockQuantity: 2 });
    if (entry === null) {
      return;
    }
    expect(
      simpleCardEntry(limited, cartState({ entries: [{ ...entry, quantity: 2 }] })),
    ).toBeNull();
    expect(simpleCardEntry({ ...limited, minimumQuantity: 3 }, cartState())).toBeNull();
    expect(
      simpleCardEntry(
        limited,
        cartState({ entries: [{ ...entry, quantity: 2, variantId: "another-variant" }] }),
      ),
    ).not.toBeNull();
  });
  it("rejects an owner minimum that is not a native package multiple", () => {
    expect(simpleCardEntry({ ...product, packageQuantity: 2 }, cartState())).toBeNull();
    expect(simpleCardEntry({ ...product, packageQuantity: 1.5 }, cartState())).toMatchObject({
      packageQuantity: 1.5,
      quantity: 3,
    });
    expect(
      simpleCardEntry({ ...product, minimumQuantity: 0.3, packageQuantity: 0.1 }, cartState()),
    ).toMatchObject({ quantity: 0.3 });
  });
  it.effect(
    "adds the actual owner minimum and unit to the existing cart reducer without a variant",
    () =>
      Effect.gen(function* exactOwnerMinimum() {
        const entry = simpleCardEntry(product, cartState());
        expect(entry).toMatchObject({
          expectedUnitPriceMinor: 1290,
          minimumQuantity: 3,
          productId: "product",
          quantity: 3,
          unit: "m",
        });
        expect(entry).not.toHaveProperty("variantId");
        if (entry === null) {
          return;
        }
        expect(yield* addCartEntry([], entry)).toEqual([entry]);
      }),
  );
  it.each([
    { minimumQuantity: 0 },
    { minimumQuantity: -1 },
    { minimumQuantity: Number.POSITIVE_INFINITY },
    { minimumQuantity: 0.0005 },
    { minimumQuantity: 1_000_001 },
    { unit: "" },
    { unit: "   " },
    { priceMinor: null },
    { priceMinor: 0 },
    { priceMinor: 12.5 },
    { stock: "unknown" },
    { stock: "unavailable" },
    { variantCount: 1 },
    { variantCount: 0, variantPreview: [{ id: "real-variant", name: "M" }] },
  ] satisfies Partial<ProductCardModel>[])(
    "does not fabricate a purchasable entry from %j",
    (changes) => {
      expect(simpleCardEntry({ ...product, ...changes }, cartState())).toBeNull();
    },
  );
  it("keeps missing minimum, unit and variant count unknown instead of defaulting", () => {
    const { minimumQuantity, unit, variantCount, ...legacy } = product;
    void minimumQuantity;
    void unit;
    void variantCount;
    expect(simpleCardEntry(legacy, cartState())).toBeNull();
    expect(simpleCardEntry({ ...legacy, unit: "m", variantCount: 0 }, cartState())).toBeNull();
    expect(
      simpleCardEntry({ ...legacy, minimumQuantity: 3, variantCount: 0 }, cartState()),
    ).toBeNull();
    expect(simpleCardEntry({ ...legacy, minimumQuantity: 3, unit: "m" }, cartState())).toBeNull();
  });
  it("requires a loaded error-free cart and a valid matching currency scope", () => {
    const current = cartState();
    for (const cart of [
      null,
      cartState({ loaded: false }),
      cartState({ error: true }),
      cartState({ scope: null }),
      cartState({ scope: { ...scope, tenantId: "invalid" } }),
      cartState({ scope: { ...scope, currency: "EUR" } }),
    ]) {
      expect(simpleCardEntry(product, cart)).toBeNull();
    }
    expect(simpleCardEntry({ ...product, stock: "limited" }, current)).not.toBeNull();
  });
  for (const saved of [true, false]) {
    registerSaveResult(saved);
  }
  it.live.each([true, false])(
    `keeps the native minimum, unit and readiness guard in the listing action (%s)`,
    (loaded) =>
      Effect.gen(function* listingReadiness() {
        let disabledBeforeRestore: boolean | undefined;
        yield* Effect.promise(() =>
          mount({
            beforeRestore: loaded
              ? undefined
              : () => {
                  disabledBeforeRestore = purchaseButton().disabled;
                  purchaseButton().click();
                },
            presentation: "listing",
          }),
        );
        expect(purchaseButton().textContent).toBe(d.addToCartListing);
        if (loaded) {
          yield* clickPurchase;
          yield* idle;
          expect(yield* storedEntries()).toEqual([
            expect.objectContaining({ productId: product.id, quantity: 3, unit: "m" }),
          ]);
          expect(toasts()).toHaveLength(1);
          expect(toasts()[0]?.querySelector('[data-part="title"]')?.textContent).toBe(
            d.shopping.added,
          );
          expect(toasts()[0]?.dataset.type).toBe("success");
        } else {
          yield* idle;
          expect(disabledBeforeRestore).toBe(true);
          expect(window.localStorage.getItem(cartStorageKey(scope))).toBeNull();
          expect(toasts()).toHaveLength(0);
        }
      }).pipe(Effect.provide(cardNetwork)),
  );
  it.live("does not mutate or announce success through a disabled handler", () =>
    Effect.gen(function* disabledPurchase() {
      let disabledBeforeRestore: boolean | undefined;
      yield* Effect.promise(() =>
        mount({
          beforeRestore: () => {
            disabledBeforeRestore = purchaseButton().disabled;
            purchaseButton().click();
          },
        }),
      );
      yield* idle;
      expect(disabledBeforeRestore).toBe(true);
      expect(window.localStorage.getItem(cartStorageKey(scope))).toBeNull();
      expect(toasts()).toHaveLength(0);
    }).pipe(Effect.provide(cardNetwork)),
  );
  it.live("prevents a reentrant second add while the cart operation is still running", () =>
    Effect.gen(function* reentrantPurchase() {
      const writes: string[] = [];
      yield* Effect.promise(() =>
        mount({
          storage: {
            getItem: (key) => window.localStorage.getItem(key),
            removeItem: (key) => window.localStorage.removeItem(key),
            setItem: (key, value) => {
              writes.push(value);
              if (writes.length === 1) {
                purchaseButton().click();
              }
              window.localStorage.setItem(key, value);
            },
          },
        }),
      );
      yield* clickPurchase;
      yield* idle;
      expect(writes).toHaveLength(1);
      expect(yield* storedEntries()).toEqual([expect.objectContaining({ quantity: 3, unit: "m" })]);
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0]?.querySelector('[data-part="title"]')?.textContent).toBe(d.shopping.added);
    }).pipe(Effect.provide(cardNetwork)),
  );
});

describe("card projection preserves purchase provenance", () => {
  it("does not claim a simple product when public variant counts disagree", () => {
    const result = projectCatalog(
      {
        market: { configured: true, currency: "CZK", marketId: "market" },
        products: [
          {
            availability: "IN_STOCK",
            grossPriceMinor: 100,
            id: "conflict",
            minimumQuantity: 3,
            name: "Conflict",
            slug: "conflict",
            stockOnHand: 5,
            storefrontVariantPreview: { total: 0, variants: [] },
            unit: "m",
            variantSummary: { count: 2, minGrossPriceMinor: 100, stockOnHand: 5 },
          },
        ],
      },
      [],
    );
    expect(result.products[0]).not.toHaveProperty("variantCount");
    expect(simpleCardEntry(result.products[0], cartState())).toBeNull();
  });
  it("retains real owner minimum and unit with explicit zero variants", () => {
    const result = projectCatalog(
      {
        market: { configured: true, currency: "CZK", marketId: "market" },
        products: [
          {
            id: "owner",
            minimumQuantity: 3,
            name: "Owner item",
            packageQuantity: 1.5,
            slug: "owner",
            storefrontVariantPreview: { total: 0, variants: [] },
            unit: "m",
          },
        ],
      },
      [],
    );
    expect(result.products[0]).toMatchObject({
      minimumQuantity: 3,
      packageQuantity: 1.5,
      unit: "m",
      variantCount: 0,
    });
  });
  it("does not invent owner minimum, unit or absence of variants in legacy card data", () => {
    const result = projectCatalog(
      {
        market: { configured: true, currency: "CZK", marketId: "market" },
        products: [{ id: "legacy", name: "Legacy", slug: "legacy" }],
      },
      [],
    );
    expect(result.products[0]).not.toHaveProperty("minimumQuantity");
    expect(result.products[0]).not.toHaveProperty("unit");
    expect(result.products[0]).not.toHaveProperty("variantCount");
    expect(simpleCardEntry(result.products[0], cartState())).toBeNull();
  });
});
