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
  it("shows the SKU and unit price separately from the changing line total", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider>
        <CartItemsTable />
      </CartProvider>,
    );
    expect(await screen.findByText("Kód produktu: A2")).not.toBeNull();
    expect(screen.getByText(/1,00\sKč \/ ks/)).not.toBeNull();
    expect(screen.getByText(/30,00\sKč/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Zvýšit množství: Vrut" }));
    await waitFor(() => expect(screen.getByText(/40,00\sKč/)).not.toBeNull());
    expect(screen.getByText(/1,00\sKč \/ ks/)).not.toBeNull();
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
