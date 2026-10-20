import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";
import { getCategories, getProducts, searchCatalog } from "@/mock-storefront/catalog";
import { normalizeCatalogSearchTerm } from "@/lib/product-variant-search";

const { push, route } = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  route: { pathname: "/" },
}));
const originalScrollIntoView = Element.prototype.scrollIntoView;

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push }),
}));

describe("SiteHeader search", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  beforeEach(() => {
    route.pathname = "/";
    push.mockReset();
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

  it("shows catalog suggestions after two characters and closes them with Escape", async () => {
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
    expect(
      within(screen.getByRole("group", { name: "Kategorie" }))
        .getByRole("option", { name: "Řetězy" })
        .getAttribute("href"),
    ).toBe("/kategorie/retezy");
    expect(
      within(screen.getByRole("group", { name: "Produkty" })).getAllByRole("option"),
    ).toHaveLength(Math.min(6, searchCatalog("retez").length));
    const allResults = screen.getByRole("link", { name: /Zobrazit všechny produkty/ });
    expect(allResults.getAttribute("href")).toBe("/vyhledavani?q=retez");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("value")).toBe("retez");
    await user.clear(input);
    await user.paste("vruty");
    expect(
      within(screen.getByRole("group", { name: "Produkty" })).getAllByRole("option"),
    ).toHaveLength(6);
  });

  it("opens a highlighted product with Enter without also submitting the search", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "DIN 766");
    const firstHref = screen.getAllByRole("option")[0].getAttribute("href");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(firstHref);
  });

  it("shows products and categories, prioritizes an exact category match and navigates with Enter", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "vruty");
    const categories = within(screen.getByRole("group", { name: "Kategorie" })).getAllByRole(
      "option",
    );
    expect(categories).toHaveLength(4);
    expect(categories[0].getAttribute("href")).toBe("/kategorie/vruty");
    expect(
      within(screen.getByRole("group", { name: "Produkty" })).getAllByRole("option"),
    ).toHaveLength(6);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/kategorie/vruty");
  });

  it("matches categories without diacritics and supports category-only results", async () => {
    const user = userEvent.setup();
    const category = getCategories().find(
      (entry) => entry.name.length >= 2 && searchCatalog(entry.name).length === 0,
    )!;
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(
      screen.getByRole("combobox", { name: "Vyhledat v katalogu" }),
      normalizeCatalogSearchTerm(category.name),
    );
    expect(screen.queryByRole("group", { name: "Produkty" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    const option = within(screen.getByRole("group", { name: "Kategorie" }))
      .getAllByRole("option")
      .find((entry) => entry.getAttribute("href") === `/kategorie/${category.slug}`)!;
    await user.click(option);
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(`/kategorie/${category.slug}`);
  });

  it("submits an unmatched query with Enter and displays the empty state", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(
      screen.getByRole("combobox", { name: "Vyhledat v katalogu" }),
      "nenalezenyproduktxyz",
    );
    expect(screen.getByRole("status").textContent).toContain("nenašli žádné produkty");

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/vyhledavani?q=nenalezenyproduktxyz");
  });

  it("preserves the matching variant in the product link when searching by SKU", async () => {
    const user = userEvent.setup();
    const product = getProducts().find((entry) => entry.detail.variants.length > 0)!;
    const variant = product.detail.variants[0];
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), variant.sku);
    const option = screen.getByRole("option", { name: `${product.name} – ${variant.label}` });
    expect(option.getAttribute("href")).toBe(
      `/produkt/${product.slug}?${new URLSearchParams({ variant: variant.sku })}#product-variants`,
    );
    await user.click(option);
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(option.getAttribute("href"));
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

    await user.type(screen.getByRole("combobox", { name: "Vyhledat v katalogu" }), "  M8 A4  ");
    await user.click(submit);

    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/vyhledavani?q=M8%20A4");
  });

  it("marks the current page in both desktop and mobile navigation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    for (const name of ["Pomocná navigace", "Mobilní navigace"]) {
      if (name === "Mobilní navigace")
        await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
      const navigation = within(screen.getByRole("navigation", { name }));
      expect(navigation.getByRole("link", { name: "Domů" }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(navigation.getByRole("link", { name: "Blog" }).hasAttribute("aria-current")).toBe(
        false,
      );
    }

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    route.pathname = "/blog";
    rerender(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    for (const name of ["Pomocná navigace", "Mobilní navigace"]) {
      if (name === "Mobilní navigace")
        await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
      const navigation = within(screen.getByRole("navigation", { name }));
      expect(navigation.getByRole("link", { name: "Blog" }).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(navigation.getByRole("link", { name: "Domů" }).hasAttribute("aria-current")).toBe(
        false,
      );
    }
  });

  it("links to sign-in with a decorative lock icon", () => {
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    const login = screen.getByRole("link", { name: "Přihlášení" });
    expect(login.getAttribute("href")).toBe("/prihlaseni");
    expect(login.hasAttribute("data-akros-header-login")).toBe(true);
    const lock = login.querySelector(".icon-\\[mdi--lock\\]");
    expect(lock?.getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes account and favorites as accessible icon links", () => {
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );

    expect(screen.getByRole("link", { name: "Můj účet" }).getAttribute("href")).toBe("/muj-ucet");
    expect(screen.getByRole("link", { name: "Oblíbené" }).getAttribute("href")).toBe("/oblibene");
  });
});
