import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import type { CatalogProduct, CatalogProductVariant } from "@/mock-storefront/types";

const variants: CatalogProductVariant[] = [
  {
    id: "item-1",
    sourceId: "1",
    sku: "10093300020005",
    label: "M 2 × 5",
    minimumQuantity: 10,
    packageQuantity: 100,
    priceMinor: 84,
    stockCount: 24_000,
    unit: "ks",
    priceTiers: [],
    parameters: [],
    isAction: false,
    isRecommended: false,
    isSale: false,
    isNew: false,
  },
  {
    id: "item-2",
    sourceId: "2",
    sku: "10093300040016",
    label: "M 4 × 16",
    minimumQuantity: 10,
    priceMinor: 194,
    stockCount: 8_500,
    unit: "ks",
    priceTiers: [],
    parameters: [],
    isAction: false,
    isRecommended: false,
    isSale: false,
    isNew: false,
  },
];

const product: CatalogProduct = {
  id: "product-hex-bolt",
  slug: "hex-bolt",
  categoryId: "bolts",
  name: "DIN 933/A2",
  sku: "10093300",
  description: "",
  priceMinor: 84,
  currency: "CZK",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 32_500,
  imageSrc: "/bolt.png",
  imageAlt: "Bolt",
  featuredPosition: null,
  isAction: false,
  isRecommended: false,
  isSale: false,
  isNew: false,
  detail: { descriptionParagraphs: [], parameters: [], priceTiers: [], variants },
};

function CartLines() {
  const { cart } = useCart();
  return <output aria-label="Řádky košíku">{JSON.stringify(cart.lines)}</output>;
}

afterEach(cleanup);

describe("ProductPurchaseForm", () => {
  it("renders the source variants through the purchase data table", () => {
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
      </CartProvider>,
    );

    expect(screen.getByRole("table", { name: "Varianty produktu" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Název" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Kód" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "M.J." })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Dostupnost" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Cena" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Množství" })).toBeTruthy();
    expect(
      (screen.getByRole("spinbutton", { name: "Počet celých balení M 2 × 5" }) as HTMLInputElement)
        .value,
    ).toBe("0");
  });

  it("adds the selected source variant with its minimum order quantity", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
        <CartLines />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Koupit M 4 × 16" }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")).toEqual([
      expect.objectContaining({
        productId: "product-hex-bolt",
        variantId: "item-2",
        sku: "10093300040016",
        priceMinor: 194,
        quantity: 10,
      }),
    ]);
  });

  it("does not allow buying an out-of-stock source variant", () => {
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={[{ ...variants[0], stockCount: 0 }]} />
      </CartProvider>,
    );

    expect(screen.getByRole("button", { name: "Koupit M 2 × 5" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("adds the source package quantity when buying a complete package", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
        <CartLines />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Koupit celé balení M 2 × 5" }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")).toEqual([
      expect.objectContaining({
        variantId: "item-1",
        quantity: 100,
      }),
    ]);
  });

  it("opens a deep-linked source variant already filtered in the table", () => {
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm
          initialVariantSearch="10093300040016"
          product={product}
          variants={variants}
        />
      </CartProvider>,
    );

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: /Koupit M 4/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Koupit M 2/ })).toBeNull();
  });

  it("filters variants by their material after submitting the filters", async () => {
    const user = userEvent.setup();
    const materialVariants = [
      { ...variants[0], label: "M 2 × 5 /A2" },
      { ...variants[1], label: "M 4 × 16 /A4" },
    ];

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={materialVariants} />
      </CartProvider>,
    );

    await user.click(screen.getByRole("checkbox", { name: "A2" }));
    await user.click(screen.getByRole("button", { name: "Filtrovat" }));

    expect(screen.getByRole("button", { name: /Koupit M 4/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Koupit M 2/ })).toBeNull();
  });

  it("adds a decimal source minimum without truncating it", async () => {
    const user = userEvent.setup();
    const profile = {
      ...product,
      id: "product-profile",
      slug: "profile",
      sku: "PROFILE-1",
      unit: "m",
      minimumQuantity: 0.5,
      stockCount: 3.5,
      detail: { descriptionParagraphs: [], parameters: [], priceTiers: [], variants: [] },
    };

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={profile} />
        <CartLines />
      </CartProvider>,
    );

    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("0.5");
    await user.click(screen.getByRole("button", { name: "Koupit" }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")).toEqual([
      expect.objectContaining({
        minimumQuantity: 0.5,
        quantity: 0.5,
        stockCount: 3.5,
        unit: "m",
      }),
    ]);
  });

  it("adds a single source variant through the simple purchase control", async () => {
    const user = userEvent.setup();
    const singleVariant = {
      ...variants[0],
      id: "item-single",
      sku: "10835300330020",
      label: "destička kulatá s okem 33x20 AN 8353/A4",
      minimumQuantity: 1,
      packageQuantity: 10,
      priceMinor: 6031,
      stockCount: 6,
    };

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variant={singleVariant} />
        <CartLines />
      </CartProvider>,
    );

    expect(screen.queryByRole("searchbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Koupit" }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")).toEqual([
      expect.objectContaining({
        productId: "product-hex-bolt",
        variantId: "item-single",
        sku: "10835300330020",
        priceMinor: 6031,
        quantity: 1,
      }),
    ]);
  });
});
