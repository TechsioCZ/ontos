import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import { CartItemsTable } from "@/features/checkout/cart-items-table";

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({
      version: 3,
      lines: [
        {
          productId: "screw",
          slug: "screw",
          name: "Vrut",
          sku: "A2",
          imageSrc: "/screw.jpg",
          imageAlt: "Vrut",
          unit: "ks",
          minimumQuantity: 10,
          stockCount: 100,
          priceMinor: 100,
          quantity: 30,
        },
      ],
    }),
  );
});
const storedQuantity = () =>
  JSON.parse(window.localStorage.getItem("akros-demo-cart-v3") ?? "null").lines[0]?.quantity;

describe("checkout cart quantity", () => {
  it("renders capitalised catalogue names in sentence case without modifying stored data", async () => {
    const stored = JSON.parse(window.localStorage.getItem("akros-demo-cart-v3")!);
    stored.lines[0].name = "MATICE ŠESTIHRANNÉ DIN934/A2";
    window.localStorage.setItem("akros-demo-cart-v3", JSON.stringify(stored));
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    expect(
      await screen.findByRole("link", { name: "Matice šestihranné DIN934/A2" }),
    ).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem("akros-demo-cart-v3")!).lines[0].name).toBe(
      "MATICE ŠESTIHRANNÉ DIN934/A2",
    );
  });

  it("shows the product and changing line total without additional SKU or unit-price rows", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    expect(await screen.findByRole("link", { name: "Vrut" })).not.toBeNull();
    expect(screen.queryByText("Kód produktu: A2")).toBeNull();
    expect(screen.queryByText(/1,00\sKč \/ ks/)).toBeNull();
    expect(screen.getByText(/30\sKč/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Zvýšit množství: Vrut" }));
    await waitFor(() => expect(screen.getByText(/40\sKč/)).not.toBeNull());
    expect(screen.queryByText(/1,00\sKč \/ ks/)).toBeNull();
  });

  it("preserves grouped four-digit quantities while incrementing and decrementing", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [
          {
            productId: "screw",
            slug: "screw",
            name: "Vrut",
            sku: "A2",
            imageSrc: "/screw.jpg",
            imageAlt: "Vrut",
            unit: "ks",
            minimumQuantity: 10,
            stockCount: 10000,
            priceMinor: 100,
            quantity: 2000,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    const input = await screen.findByRole("spinbutton");
    expect(input.getAttribute("aria-valuenow")).toBe("2000");
    expect(screen.getByDisplayValue(/^2\s000$/)).toBe(input);
    await user.click(screen.getByRole("button", { name: "Zvýšit množství: Vrut" }));
    await waitFor(() => expect(storedQuantity()).toBe(2010));
    await user.click(screen.getByRole("button", { name: "Snížit množství: Vrut" }));
    await waitFor(() => expect(storedQuantity()).toBe(2000));
    expect(screen.getByDisplayValue(/^2\s000$/)).toBe(input);
  });

  it("lets a shopper type a multi-digit quantity without clamping the first digit", async () => {
    const user = userEvent.setup({ delay: 40 });
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    const input = await screen.findByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "2");
    expect(storedQuantity()).toBe(30);
    await user.type(input, "0");
    await user.tab();
    await waitFor(() => expect(storedQuantity()).toBe(20));
    expect(screen.getByDisplayValue("20")).not.toBeNull();
  });

  it("normalizes an unfinished quantity on blur without deleting the line", async () => {
    const user = userEvent.setup({ delay: 40 });
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    const input = await screen.findByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "15");
    await user.tab();
    await waitFor(() => expect(storedQuantity()).toBe(10));
    expect(screen.getByDisplayValue("10")).not.toBeNull();
    await user.clear(input);
    await user.tab();
    expect(storedQuantity()).toBeGreaterThanOrEqual(10);
    expect(screen.getByRole("spinbutton").getAttribute("aria-valuenow")).not.toBeNull();
  });
});
