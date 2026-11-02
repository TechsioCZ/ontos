import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import { AccountOrders } from "@/features/account/account-orders";
import { CartProvider } from "@/features/cart/cart-provider";
import type { CustomerOrder } from "@/ontos/order-model";

const order = (id: string, createdAt: string, status: CustomerOrder["status"]): CustomerOrder => ({
  id,
  customerAccountId: "acc",
  number: `2026-${id}`,
  status,
  createdAt,
  updatedAt: createdAt,
  totalMinor: 24200,
  totalVatMinor: 4200,
  lines: [
    {
      productId: "p",
      productName: "Šrouby",
      sku: "SKU-a",
      quantity: 20,
      unitPriceMinor: 1210,
      vatRate: 21,
      variantId: "a",
      variantName: "M 6 × 20",
    },
  ],
});
const orders = [
  order("002", "2026-10-12T10:00:00Z", "SHIPPED"),
  order("001", "2026-09-03T10:00:00Z", "DELIVERED"),
];

describe("account orders from OntOS", () => {
  afterEach(cleanup);

  it("offers repeat, detail and filters built from the real order history", async () => {
    render(
      <CartProvider storage={null}>
        <AccountOrders orders={orders} total={2} />
      </CartProvider>,
    );
    const cards = within(
      document.querySelector<HTMLElement>("[data-account-order-cards]")!,
    ).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("button", { name: "Objednat znovu 2026-002" })).toBeTruthy();
    expect(
      within(cards[0]).getByRole("link", { name: "Detail objednávky" }).getAttribute("href"),
    ).toBe("/detail-objednavky?order=002");
    expect(within(cards[0]).getByText("Předáno dopravci")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sledovat poslední zásilku" }).getAttribute("href"),
    ).toBe("/sledovani-zasilky?order=002");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Číslo objednávky"), "001");
    expect(screen.getByText("Zobrazeno 1 z 2 objednávek")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Zrušit filtry" }));
    expect(screen.getByText("Zobrazeno 2 z 2 objednávek")).toBeTruthy();
  });

  it("shows a saved order with its repeat action and receipt amounts", () => {
    render(
      <CartProvider storage={null}>
        <AccountOrderDetail order={orders[0]} />
      </CartProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Objednávka 2026-002" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Objednat znovu 2026-002" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sledovat zásilku" }).getAttribute("href")).toBe(
      "/sledovani-zasilky?order=002",
    );
    expect(screen.getAllByText("Šrouby – M 6 × 20").length).toBeGreaterThan(0);
  });
});
