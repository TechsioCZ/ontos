import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";

const originalScrollIntoView = Element.prototype.scrollIntoView;
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

describe("SiteHeader search through the OntOS BFF", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn<Element["scrollIntoView"]>();
  });

  it("shows product suggestions from the OntOS search BFF and its total", async () => {
    const fetchMock = vi.fn(async () =>
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
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "šroub");
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Produkty" }))
          .getByRole("option", { name: /Šroub z OntOS/ })
          .getAttribute("href"),
      ).toBe("/produkt/sroub-z-ontos"),
    );
    expect(screen.getByRole("link", { name: "Zobrazit všechny produkty (37)" })).toBeDefined();
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("/api/ontos/search");
    expect(JSON.parse(String(init.body))).toEqual({ q: "šroub" });
  });

  it("shows „Cena není dostupná“ instead of 0,00 Kč for a zero or foreign-currency suggestion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
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
      ),
    );
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
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
    expect(euro.querySelector("[data-akros-search-price-unavailable]")?.getAttribute("title")).toBe(
      "Cena je v nepodporované měně (EUR); e-shop prodává jen v Kč.",
    );
  });
});
