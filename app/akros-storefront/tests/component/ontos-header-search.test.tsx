import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { publicAppRouterInstance } from "next/dist/client/components/app-router-instance";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { browserAt, serveHttp } from "../support/http";
import { renderStorefront } from "../support/storefront";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";

let network: Awaited<ReturnType<typeof serveHttp>> | undefined;

function renderHeader() {
  renderStorefront(
    <AppRouterContext.Provider value={publicAppRouterInstance}>
      <PathnameContext.Provider value="/cs">
        <CartProvider storage={null}>
          <SiteHeader />
        </CartProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

describe("SiteHeader search through the OntOS BFF", () => {
  afterEach(async () => {
    cleanup();
    if (network) {
      await network.idle();
      await network.close();
      network = undefined;
    }
  });

  it("shows product suggestions from the OntOS search BFF and its total", async () => {
    network = await serveHttp(async () =>
      Response.json({
        total: 37,
        items: [
          {
            productId: "p1",
            slug: "sroub-z-ontos",
            name: "Šroub z OntOS",
            imageSrc: "/akros/products/product-02.jpg",
            currency: "CZK",
            priceMinor: 12100,
            priceIsFrom: true,
            hasVariants: false,
          },
        ],
      }),
    );
    browserAt(`${network.origin}/cs`);
    const user = userEvent.setup();
    renderHeader();
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "šroub");
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Produkty" }))
          .getByRole("option", { name: /Šroub z OntOS/ })
          .getAttribute("href"),
      ).toBe("/cs/produkt/sroub-z-ontos"),
    );
    expect(screen.getByRole("link", { name: "Zobrazit všechny produkty (37)" })).toBeDefined();
    await network.idle();
    const request = network.requests.at(-1);
    expect(request).toBeDefined();
    if (!request) throw new Error("No search request reached the HTTP server");
    expect(new URL(request.url).pathname).toBe("/api/ontos/search");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ q: "šroub" });
  });

  it("shows „Cena není dostupná“ instead of 0,00 Kč for a zero or foreign-currency suggestion", async () => {
    network = await serveHttp(async () =>
      Response.json({
        total: 2,
        items: [
          {
            productId: "p0",
            slug: "sroub-bez-ceny",
            name: "Šroub bez ceny",
            imageSrc: "/akros/products/product-02.jpg",
            currency: "CZK",
            priceMinor: 0,
            priceIsFrom: false,
            hasVariants: false,
          },
          {
            productId: "p1",
            slug: "sroub-v-eurech",
            name: "Šroub v eurech",
            imageSrc: "/akros/products/product-02.jpg",
            currency: "EUR",
            priceMinor: 500,
            priceIsFrom: false,
            hasVariants: false,
          },
        ],
      }),
    );
    browserAt(`${network.origin}/cs`);
    const user = userEvent.setup();
    renderHeader();
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "šroub");
    const products = await waitFor(() => {
      const group = screen.getByRole("group", { name: "Produkty" });
      expect(within(group).getAllByRole("option")).toHaveLength(2);
      return group;
    });
    const zero = within(products).getByRole("option", { name: /Šroub bez ceny/ });
    const euro = within(products).getByRole("option", { name: /Šroub v eurech/ });
    for (const option of [zero, euro]) {
      expect(option.textContent).toContain("Cena není dostupná");
      expect(option.textContent).not.toMatch(/0,00|€|Kč/);
    }
    expect(euro.querySelector("[data-sf-search-price-unavailable]")?.getAttribute("title")).toBe(
      "Cena je v nepodporované měně (EUR); e-shop prodává jen v Kč.",
    );
  });
});
