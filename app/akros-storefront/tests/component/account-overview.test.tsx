import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AccountOverview } from "@/features/account/account-overview";
import { MarketProvider, type ClientMarket } from "@/ontos/market-context";
import type { CustomerOrder } from "@/ontos/order-model";

const account = {
  id: "portal-1",
  partyId: "party-1",
  tenantId: "tenant-1",
  email: "jana@example.test",
  name: "Jana Testová",
};
const order: CustomerOrder = {
  id: "order-7",
  customerAccountId: "portal-1",
  number: "OBJ-2026-0042",
  status: "SHIPPED",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  totalMinor: 25950,
  totalVatMinor: 4504,
  lines: [
    {
      productId: "p",
      productName: "Vruty",
      sku: "V-1",
      quantity: 2,
      unitPriceMinor: 100,
      vatRate: 21,
    },
    {
      productId: "q",
      productName: "Matice",
      sku: "M-1",
      quantity: 1,
      unitPriceMinor: 100,
      vatRate: 21,
    },
  ],
  market: { marketId: "m-sk", marketCode: "AKROS-SK", currency: "EUR" },
};
const market = (locale: "cs" | "sk"): ClientMarket => ({
  locale,
  marketCode: locale === "sk" ? "AKROS-SK" : "AKROS-CZ",
  currency: locale === "sk" ? "EUR" : "CZK",
  formatLocale: locale === "sk" ? "sk-SK" : "cs-CZ",
  configured: true,
  live: [],
});
const renderIn = (locale: "cs" | "sk", latest?: CustomerOrder | null) =>
  render(
    <MarketProvider market={market(locale)}>
      <AccountOverview account={account} latest={latest} />
    </MarketProvider>,
  );

afterEach(cleanup);

describe("account overview (Kai's layout on OntOS data)", () => {
  it("shows the latest OntOS order with its actions, the account and four shortcuts", () => {
    renderIn("cs", order);
    expect(screen.getByRole("heading", { name: "Poslední objednávka" })).toBeTruthy();
    expect(screen.getByText("OBJ-2026-0042")).toBeTruthy();
    expect(screen.getByText("Předáno dopravci")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sledovat zásilku" }).getAttribute("href")).toBe(
      "/cs/sledovani-zasilky?order=order-7",
    );
    expect(screen.getByRole("link", { name: "Detail objednávky" }).getAttribute("href")).toBe(
      "/cs/detail-objednavky?order=order-7",
    );
    expect(screen.getByRole("link", { name: "Upravit můj účet" }).getAttribute("href")).toBe(
      "/cs/muj-ucet",
    );
    expect(screen.getByText("jana@example.test")).toBeTruthy();
    const shortcuts = screen.getByRole("navigation", { name: "Rychlé odkazy účtu" });
    expect(
      within(shortcuts)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/cs/historie-objednavek",
      "/cs/oblibene",
      "/cs/muj-ucet",
      "/cs/muj-ucet/reklamace",
    ]);
  });

  it("speaks Slovak on /sk without Czech copy", () => {
    const { container } = renderIn("sk", order);
    expect(screen.getByRole("heading", { name: "Posledná objednávka" })).toBeTruthy();
    const text = (container.textContent ?? "").replace(account.name, "");
    expect(text).not.toMatch(/[ěřůĚŘŮ]/u);
  });

  it("says when there is no order yet, and when OntOS could not be read", () => {
    renderIn("cs", null);
    expect(screen.getByText("Zatím nemáte žádné objednávky.")).toBeTruthy();
    cleanup();
    renderIn("cs", undefined);
    expect(screen.getByRole("alert").textContent).toBe(
      "Poslední objednávku se teď nepodařilo načíst z OntOS.",
    );
  });
});
