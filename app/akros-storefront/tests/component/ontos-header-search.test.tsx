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
vi.mock("@/ontos/catalog-provider", async () => {
  const model = await import("@/mock-storefront/catalog");
  return { useCatalog: () => model, useDataSource: () => "ontos" };
});

describe("SiteHeader search in OntOS mode", () => {
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
            matchingVariantCount: 0,
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
});
