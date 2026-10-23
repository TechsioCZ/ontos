import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";
import type {
  RemoteCategorySuggestion,
  RemoteSearchResponse,
  RemoteSearchSuggestion,
} from "@/ontos/search-suggestions";

const { push, route } = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  route: { pathname: "/" },
}));
const originalScrollIntoView = Element.prototype.scrollIntoView;
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
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json(body),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
    respondWith({ total: 0, items: [], categories: [] });
  });

  it("shows BFF suggestions after two characters and closes them with Escape", async () => {
    const fetchMock = respondWith({
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
      ).toBe("/kategorie/retezy"),
    );
    expect(
      within(screen.getByRole("group", { name: "Produkty" })).getAllByRole("option"),
    ).toHaveLength(1);
    const allResults = screen.getByRole("link", { name: /Zobrazit všechny produkty/ });
    expect(allResults.getAttribute("href")).toBe("/vyhledavani?q=retez");
    expect(
      fetchMock.mock.calls.every(([, init]) => JSON.parse(String(init.body)).q.length >= 2),
    ).toBe(true);

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
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/produkt/retez-din-766");
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
    expect(categories[0].getAttribute("href")).toBe("/kategorie/vruty");
    expect(categories[0].textContent).toContain("Nerezový spojovací materiál");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/kategorie/vruty");
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
      expect(screen.getByRole("status").textContent).toContain("nenašli žádné produkty"),
    );

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/vyhledavani?q=nenalezenyproduktxyz");
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
      `/produkt/retez-din-766?${new URLSearchParams({ variant: "766-A4-8" })}`,
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

    const input = screen.getByRole("combobox", { name: "Vyhledat v katalogu" });
    await user.click(input);
    await user.paste("  M8 A4  ");
    await waitFor(() => expect(input.getAttribute("value")).toBe("  M8 A4  "));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("nenašli žádné produkty"),
    );
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
