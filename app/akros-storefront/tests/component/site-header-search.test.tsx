import { settleBrowser } from "../support/browser";
// Run Next's own browser initialization before hydrating its router.
import "next/dist/client/app-bootstrap";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReactNode } from "react";
import { NextRouter } from "../support/router";
import { restore } from "next/dist/client/components/navigator";
import { renderStorefront } from "../support/storefront";
import { browserAt, serveHttp } from "../support/http";

import { SiteHeader } from "@/components/site-header";
import { akros } from "@/brand/akros";
import { CartProvider } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import type {
  RemoteCategorySuggestion,
  RemoteSearchResponse,
  RemoteSearchSuggestion,
} from "@/ontos/search-suggestions";

let network: Awaited<ReturnType<typeof serveHttp>>;
let response: RemoteSearchResponse;
let hydrated = false;

function render(ui: ReactNode) {
  const result = renderStorefront(<NextRouter>{ui}</NextRouter>);
  hydrated = true;
  return result;
}

async function expectNavigation(href: string | null, exactlyOnce = true) {
  if (href === null) throw new Error("Navigation target is missing");
  const expected = new URL(href, network.origin);
  // Native Next may canonicalize a query space as + rather than %20. Keep the exact
  // path, decoded ordered query pairs and fragment, not the incidental URL spelling.
  await waitFor(() => {
    const actual = new URL(window.location.href);
    expect([actual.pathname, [...actual.searchParams], actual.hash]).toEqual([
      expected.pathname,
      [...expected.searchParams],
      expected.hash,
    ]);
  });
  await settleBrowser();
  const navigations = network.requests.filter((request) => request.method === "GET");
  if (exactlyOnce) expect(navigations).toHaveLength(1);
  expect(
    navigations.map((request) => {
      const url = new URL(request.url);
      url.searchParams.delete("_rsc");
      // HTTP omits fragments; the browser URL assertion above keeps that coverage.
      return [url.pathname, [...url.searchParams]];
    }),
  ).toContainEqual([expected.pathname, [...expected.searchParams]]);
}

const product: RemoteSearchSuggestion = {
  productId: "p1",
  slug: "retez-din-766",
  name: "Řetěz DIN 766",
  imageSrc: "/akros/products/product-02.jpg",
  currency: "CZK",
  priceMinor: 12100,
  priceIsFrom: true,
  hasVariants: false,
};
const retezy: RemoteCategorySuggestion = {
  id: "c-retezy",
  slug: "retezy",
  name: "Řetězy",
  trail: "Nerezový spojovací materiál",
};
const vruty: RemoteCategorySuggestion = {
  id: "c-vruty",
  slug: "vruty",
  name: "Vruty",
  trail: "Nerezový spojovací materiál",
};
function respondWith(body: RemoteSearchResponse) {
  response = body;
}

describe("SiteHeader search", () => {
  afterEach(async () => {
    cleanup();
    await network.close();
  });

  beforeEach(async () => {
    respondWith({ total: 0, items: [], categories: [] });
    // An HTML destination exercises Next's native document-navigation path.
    network = await serveHttp((request) =>
      new URL(request.url).pathname === "/api/ontos/search"
        ? Response.json(response)
        : new Response("<!doctype html><title>Storefront destination</title>", {
            headers: { "content-type": "text/html" },
          }),
    );
    browserAt(`${network.origin}/cs`);
    if (hydrated) act(() => restore(new URL(`${network.origin}/cs`), undefined));
  });

  it("shows BFF suggestions after two characters and closes them with Escape", async () => {
    respondWith({
      total: 9,
      items: [product],
      categories: [retezy],
    });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Vyhledat v katalogu" });

    await user.type(input, "r");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(input, "etez");
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Kategorie" }))
          .getByRole("option", { name: /Řetězy/ })
          .getAttribute("href"),
      ).toBe("/cs/kategorie/retezy"),
    );
    expect(
      within(screen.getByRole("group", { name: "Produkty" })).getAllByRole("option"),
    ).toHaveLength(1);
    const allResults = screen.getByRole("link", { name: /Zobrazit všechny produkty/ });
    expect(allResults.getAttribute("href")).toBe("/cs/vyhledavani?q=retez");
    await settleBrowser();
    const queries = await Promise.all(
      network.requests
        .filter((request) => new URL(request.url).pathname === "/api/ontos/search")
        .map(async (request) => (await request.json()).q),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => query.length >= 2)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("value")).toBe("retez");
  });

  it("opens a highlighted product with Enter without also submitting the search", async () => {
    respondWith({ total: 1, items: [product], categories: [] });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "DIN 766");
    await screen.findByRole("option", { name: /Řetěz DIN 766/ });

    await user.keyboard("{ArrowDown}{Enter}");
    await expectNavigation("/cs/produkt/retez-din-766");
  });

  it("lists BFF categories before products and navigates to a category with Enter", async () => {
    respondWith({ total: 1, items: [product], categories: [vruty, retezy] });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "vruty");
    const categories = await waitFor(() =>
      within(screen.getByRole("group", { name: "Kategorie" })).getAllByRole("option"),
    );
    expect(categories).toHaveLength(2);
    expect(categories[0].getAttribute("href")).toBe("/cs/kategorie/vruty");
    expect(categories[0].textContent).toContain("Nerezový spojovací materiál");
    await user.keyboard("{ArrowDown}{Enter}");
    await expectNavigation("/cs/kategorie/vruty");
  });

  it("submits an unmatched query with Enter and displays the empty state", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }));
    await user.paste("nenalezenyproduktxyz");
    await waitFor(() =>
      expect(screen.getByText(/nenašli žádné produkty/u).getAttribute("role")).toBe("status"),
    );

    await user.keyboard("{Enter}");
    await expectNavigation("/cs/vyhledavani?q=nenalezenyproduktxyz");
  });

  it("opens a variant group with its variant table filtered by the query", async () => {
    respondWith({ total: 1, items: [{ ...product, hasVariants: true }], categories: [] });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }));
    await user.paste("766-A4-8");
    const option = await screen.findByRole("option", { name: /Řetěz DIN 766/ });
    expect(option.getAttribute("href")).toBe(
      `/cs/produkt/retez-din-766?${new URLSearchParams({ variant: "766-A4-8" })}#product-variants`,
    );
    await user.click(option);
    await expectNavigation(option.getAttribute("href"));
  });

  it("routes an exact SKU hit to the exact variant with its own price", async () => {
    respondWith({
      total: 1,
      items: [
        {
          ...product,
          hasVariants: true,
          priceIsFrom: false,
          priceMinor: 2_54,
          variantLabel: "8 x 1000 mm",
          variantSku: "766A48",
          path: "/produkt/retez-din-766?variantIds=item-9025#product-variants",
        },
      ],
      categories: [],
    });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }));
    await user.paste("766A48");
    const option = await screen.findByRole("option", { name: /Řetěz DIN 766 – 8 x 1000 mm/ });
    expect(option.getAttribute("href")).toBe(
      "/cs/produkt/retez-din-766?variantIds=item-9025#product-variants",
    );
    expect(within(option).getByText(formatPrice(2_54).replace(/\s/g, " "))).toBeTruthy();
    expect(within(option).queryByText("Cena dle varianty")).toBeNull();
    await user.click(option);
    await expectNavigation(option.getAttribute("href"), false);
  });

  it("shows a variant-price prompt instead of a lower-bound price in group suggestions", async () => {
    respondWith({
      total: 1,
      items: [{ ...product, hasVariants: true, priceIsFrom: true }],
      categories: [],
    });
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }));
    await user.paste("DIN 766");
    const option = await screen.findByRole("option", { name: /Řetěz DIN 766/ });
    expect(within(option).getByText("Cena dle varianty")).toBeTruthy();
    expect(option.textContent).not.toMatch(/od \d|Kč/);
  });

  it("submits a trimmed query through an accessible icon button", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    const submit = screen.getByRole("button", { name: "Hledat" });
    expect(submit.textContent).toBe("");

    const input = screen.getByRole("combobox", { name: "Vyhledat v katalogu" });
    await user.click(input);
    await user.paste("  M8 A4  ");
    await waitFor(() => expect(input.getAttribute("value")).toBe("  M8 A4  "));
    await waitFor(() =>
      expect(screen.getByText(/nenašli žádné produkty/u).getAttribute("role")).toBe("status"),
    );
    await user.click(submit);

    await expectNavigation("/cs/vyhledavani?q=M8%20A4");
  });

  it("marks only the active information page and keeps home on the logo", async () => {
    const user = userEvent.setup();
    const rendered = render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    expect(
      screen.getByRole("link", { name: cs.footer.homeLinkLabel(akros.name) }).getAttribute("href"),
    ).toBe("/cs");

    for (const name of ["Pomocná navigace", "Mobilní navigace"]) {
      if (name === "Mobilní navigace")
        await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
      const navigation = within(screen.getByRole("navigation", { name }));
      expect(navigation.queryByRole("link", { name: "Domů" })).toBeNull();
      expect(
        navigation.getAllByRole("link").some((link) => link.hasAttribute("aria-current")),
      ).toBe(false);
      expect(navigation.getByRole("link", { name: "Blog" }).hasAttribute("aria-current")).toBe(
        false,
      );
    }

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => restore(new URL("/cs/blog", network.origin), undefined));
    rendered.rerender(
      <NextRouter>
        <CartProvider storage={null}>
          <SiteHeader />
        </CartProvider>
      </NextRouter>,
    );

    for (const name of ["Pomocná navigace", "Mobilní navigace"]) {
      if (name === "Mobilní navigace")
        await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
      const navigation = within(screen.getByRole("navigation", { name }));
      expect(navigation.getByRole("link", { name: "Blog" }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(
        navigation.getByRole("link", { name: "Obchodní podmínky" }).hasAttribute("aria-current"),
      ).toBe(false);
    }
  });

  it("links to sign-in with a decorative lock icon", () => {
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    const login = screen.getByRole("link", { name: "Přihlášení" });
    expect(login.getAttribute("href")).toBe("/cs/prihlaseni");
    expect(login.hasAttribute("data-sf-header-login")).toBe(true);
    const lock = login.querySelector(".icon-\\[mdi--lock\\]");
    expect(lock?.getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes account and favorites as accessible icon links", () => {
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    expect(screen.getByRole("link", { name: "Můj účet" }).getAttribute("href")).toBe(
      "/cs/muj-ucet",
    );
    expect(screen.getByRole("link", { name: "Oblíbené" }).getAttribute("href")).toBe(
      "/cs/oblibene",
    );
  });
});
