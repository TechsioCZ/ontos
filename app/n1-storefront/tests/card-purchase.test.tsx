import { rs } from "@rstest/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "effect-rstest";
import { CardPurchase } from "../src/features/card-purchase";
import { simpleCardEntry } from "../src/features/card-purchase-model";
import { useCart } from "../src/features/cart-provider";
import { addCartEntry } from "../src/features/cart-state";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import type { ProductCardModel } from "../src/ontos/catalog-model";

const feedback = rs.hoisted(() => {
  const actions: (() => void)[] = [];
  return { actions, create: rs.fn() };
});
rs.mock("@techsio/ui-kit/molecules/toast", () => ({
  useToast: () => ({ create: feedback.create }),
}));
rs.mock("../src/features/cart-provider", () => ({ useCart: rs.fn() }));
rs.mock("@techsio/ui-kit/atoms/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled: boolean;
    onClick: () => void;
  }) => {
    feedback.actions.push(onClick);
    return (
      <button disabled={disabled} onClick={onClick} type="button">
        {children}
      </button>
    );
  },
}));
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
beforeEach(() => {
  rs.clearAllMocks();
  feedback.actions.length = 0;
});

describe("simple card purchase uses real native values", () => {
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
    it(`announces only the actual ${saved ? "saved" : "failed"} cart result`, () => {
      const add = rs.fn(() => saved);
      rs.mocked(useCart).mockReturnValue(cartState({ add }));
      const d = getDictionary("cs");
      const html = renderToStaticMarkup(<CardPurchase dictionary={d} product={product} />);
      feedback.actions[0]?.();
      expect(add).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ quantity: 3, unit: "m" }),
      );
      expect(feedback.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          description: saved ? "3 × Owner cable" : undefined,
          title: saved ? d.shopping.added : d.shopping.addFailed,
          type: saved ? "success" : "error",
        }),
      );
      expect(html).not.toContain("disabled");
      expect(html).not.toContain("href=");
    });
  }
  it("does not mutate or announce success through a disabled handler", () => {
    const add = rs.fn(() => true);
    rs.mocked(useCart).mockReturnValue(cartState({ add, loaded: false }));
    const html = renderToStaticMarkup(
      <CardPurchase dictionary={getDictionary("cs")} product={product} />,
    );
    feedback.actions[0]?.();
    expect(html).toContain("disabled");
    expect(add).not.toHaveBeenCalled();
    expect(feedback.create).not.toHaveBeenCalled();
  });
  it("prevents a reentrant second add while the cart operation is still running", () => {
    const add = rs.fn(() => {
      feedback.actions[0]?.();
      return true;
    });
    rs.mocked(useCart).mockReturnValue(cartState({ add }));
    renderToStaticMarkup(<CardPurchase dictionary={getDictionary("cs")} product={product} />);
    feedback.actions[0]?.();
    expect(add).toHaveBeenCalledTimes(1);
    expect(feedback.create).toHaveBeenCalledTimes(1);
  });
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
