import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import type { CatalogProduct, CatalogProductVariant } from "@/ontos/catalog-types";

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
  variantSummary: { count: 2, minGrossPriceMinor: 84, stockOnHand: 32_500, units: ["ks"] },
  isAction: false,
  isRecommended: false,
  isSale: false,
  isNew: false,
  detail: { descriptionParagraphs: [], parameters: [], priceTiers: [], variants },
};

function CartLines() {
  const { cart, purchaseError } = useCart();
  return (
    <>
      <output aria-label="Řádky košíku">{JSON.stringify(cart.lines)}</output>
      <output aria-label="Chyba nákupu">{purchaseError}</output>
    </>
  );
}

afterEach(cleanup);

describe("ProductPurchaseForm", () => {
  it.each([
    { minimumQuantity: 200, packageQuantity: 200, quantityStep: 200, unit: "ks" },
    { minimumQuantity: 100, packageQuantity: 100, quantityStep: 100, unit: "m" },
    { minimumQuantity: 400, packageQuantity: 200, quantityStep: 200, unit: "ks" },
  ])("only adds authoritative package multiples: %j", async (constraints) => {
    const user = userEvent.setup();
    const live = { ...variants[0], ...constraints };
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={[live]} />
        <CartLines />
      </CartProvider>,
    );
    expect(screen.getByText(/Pouze celá balení/)).toBeTruthy();
    expect(
      (screen.getByRole("spinbutton", { name: "Množství M 2 × 5" }) as HTMLInputElement).value,
    ).toBe(String(live.minimumQuantity));
    await user.click(screen.getByRole("button", { name: "Koupit M 2 × 5" }));
    let lines = JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]");
    expect(lines[0].quantity).toBe(live.minimumQuantity);
    await user.click(screen.getByRole("button", { name: "Koupit celé balení M 2 × 5" }));
    lines = JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]");
    expect(lines[0].quantity).toBe(live.minimumQuantity * 2);
    expect(lines[0].quantity % live.packageQuantity).toBe(0);
  });

  it("synchronizes typed range limits and slider values, applying them only on submit", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
      </CartProvider>,
    );
    let minimum = screen.getByRole("spinbutton", { name: "Minimum – Průměr (mm)" });
    await user.clear(minimum);
    await user.type(minimum, "3");
    const sliders = screen.getAllByRole("slider", { name: /Průměr/ });
    expect(sliders[0].getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByRole("button", { name: /Koupit M 2/ })).toBeTruthy();
    await user.click(sliders[0]);
    await user.keyboard("{ArrowLeft}");
    minimum = screen.getByRole("spinbutton", { name: "Minimum – Průměr (mm)" });
    expect((minimum as HTMLInputElement).value).toBe("2");
    await user.clear(minimum);
    await user.type(minimum, "3");
    await user.click(screen.getByRole("button", { name: "Filtruj" }));
    expect(screen.queryByRole("button", { name: /Koupit M 2/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Koupit M 4/ })).toBeTruthy();
  });

  it("converts Czech decimal price inputs to minor units without changing quantity inputs", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
      </CartProvider>,
    );
    const minimum = screen.getByRole("spinbutton", { name: "Minimum – Cena (Kč/ks)" });
    await user.click(minimum);
    // Dispatch the resulting input text without relying on jsdom's caret emulation.
    fireEvent.input(minimum, { target: { value: "1,25" } });
    expect((minimum as HTMLInputElement).value).toBe("1,25");
    await user.tab();
    expect(screen.getAllByRole("slider", { name: /Cena/ })[0].getAttribute("aria-valuenow")).toBe(
      "125",
    );
    await user.click(screen.getByRole("button", { name: "Filtruj" }));
    expect(screen.queryByRole("button", { name: /Koupit M 2/ })).toBeNull();
    expect(
      (screen.getByRole("spinbutton", { name: "Množství M 4 × 16" }) as HTMLInputElement).value,
    ).toBe("10");
  });

  it("keeps range limits ordered when an input exceeds the other endpoint", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
      </CartProvider>,
    );
    const maximum = screen.getByRole("spinbutton", { name: "Maximum – Průměr (mm)" });
    await user.clear(maximum);
    await user.type(maximum, "1");
    await user.tab();
    const sliders = screen.getAllByRole("slider", { name: /Průměr/ });
    // NumericInput synchronizes its displayed value on the next animation frame.
    await waitFor(() => {
      expect(Number(sliders[0].getAttribute("aria-valuenow"))).toBeLessThanOrEqual(
        Number(sliders[1].getAttribute("aria-valuenow")),
      );
      expect(Number((maximum as HTMLInputElement).value)).toBeGreaterThanOrEqual(2);
    });
  });

  it("keeps source SKU and the unit of the price in each responsive variant row", () => {
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
      </CartProvider>,
    );

    const row = screen.getByRole("button", { name: "Koupit M 2 × 5" }).closest("tr")!;
    expect(within(row).getByText("Kód:")).toBeTruthy();
    expect(within(row).getByText(variants[0].sku)).toBeTruthy();
    expect(within(row).getByText("/ ks")).toBeTruthy();
  });

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
    await user.click(screen.getByRole("button", { name: "Filtruj" }));

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

  it.each([false, true])(
    "validates the cumulative quantity tier before adding a product (variant list: %s)",
    async (variantList) => {
      const user = userEvent.setup();
      const priceTiers = [
        { minimumQuantity: 4, priceMinor: 60, priceExcludingVatMinor: 50 },
        { minimumQuantity: 2, priceMinor: 70, priceExcludingVatMinor: 58 },
      ];
      const requests: { quantity: number; priceMinor: number }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<(url: string, init: { body: string }) => Promise<Response>>(async (_url, init) => {
          const { cart } = JSON.parse(init.body);
          const line = cart.lines[0];
          requests.push({ quantity: line.quantity, priceMinor: line.priceMinor });
          const priceMinor = line.quantity >= 4 ? 60 : 70;
          const priceChanged = line.priceMinor !== priceMinor;
          return Response.json({
            cart: { ...cart, lines: [{ ...line, priceMinor }] },
            priceChanged,
            issues: [],
            canCheckout: !priceChanged,
          });
        }),
      );
      const tieredProduct = { ...product, detail: { ...product.detail, priceTiers } };
      const tieredVariant = { ...variants[0], minimumQuantity: 1, packageQuantity: 1, priceTiers };
      render(
        <CartProvider storage={null}>
          <ProductPurchaseForm
            product={tieredProduct}
            variants={variantList ? [tieredVariant] : undefined}
          />
          <CartLines />
        </CartProvider>,
      );
      const quantity = screen.getByRole("spinbutton", {
        name: variantList ? "Množství M 2 × 5" : "Množství",
      });
      await user.clear(quantity);
      await user.type(quantity, "2");
      await user.tab();
      const buy = screen.getByRole("button", { name: variantList ? "Koupit M 2 × 5" : "Koupit" });
      await user.click(buy);
      await waitFor(() =>
        expect(
          JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")[0],
        ).toMatchObject({
          quantity: 2,
          priceMinor: 70,
        }),
      );
      await user.click(buy);
      await waitFor(() =>
        expect(
          JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")[0],
        ).toMatchObject({
          quantity: 4,
          priceMinor: 60,
        }),
      );
      expect(requests).toEqual([
        { quantity: 2, priceMinor: 70 },
        { quantity: 4, priceMinor: 60 },
      ]);
    },
  );

  it("still rejects an owner price change instead of silently accepting it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () =>
        Response.json({ cart: { version: 3, lines: [] }, priceChanged: true, canCheckout: false }),
      ),
    );
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} />
        <CartLines />
      </CartProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Koupit" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Chyba nákupu").textContent).toContain("Cena se změnila"),
    );
    expect(screen.getByLabelText("Řádky košíku").textContent).toBe("[]");
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

// Transport boundary: the component must await an owner verdict before changing cart state.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { cart } = JSON.parse(init.body);
      const blocked = cart.lines.some(
        (line: { quantity: number; stockCount: number }) => line.quantity > line.stockCount,
      );
      return Response.json({
        cart,
        priceChanged: false,
        issues: blocked ? ["OntOS: požadované množství není skladem."] : [],
        canCheckout: !blocked,
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
