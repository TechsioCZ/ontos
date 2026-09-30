import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";

const { route } = vi.hoisted(() => ({ route: { pathname: "/" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useRouter: () => ({ push: vi.fn<(href: string) => void>() }),
}));

beforeEach(() => {
  route.pathname = "/";
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SiteHeader mobile navigation", () => {
  it("opens one modal with catalog, account and information links, then restores focus", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Otevřít navigaci" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const catalog = within(dialog).getByRole("navigation", { name: "Katalog" });
    expect(
      within(catalog)
        .getByRole("link", { name: "Nerezový spojovací materiál" })
        .getAttribute("href"),
    ).toBe("/kategorie/nerezovy-spojovaci-material");
    for (const [name, href] of [
      ["Přihlášení", "/prihlaseni"],
      ["Můj účet", "/muj-ucet"],
      ["Oblíbené", "/oblibene"],
      ["Kontakty", "/kontakty"],
    ]) {
      expect(within(dialog).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps category toggles inside the panel and closes it on navigation, including the current URL", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const branch = within(dialog).getByRole("button", { name: "Nerezový spojovací materiál" });
    expect(branch.getAttribute("aria-expanded")).toBe("false");
    await user.click(branch);
    expect(branch.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog")).toBe(dialog);

    await user.click(within(dialog).getByRole("link", { name: "Domů" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the active category trail and closes on a route change", async () => {
    const user = userEvent.setup();
    route.pathname = "/kategorie/a-2-141";
    const { rerender } = render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(dialog).getByRole("link", { name: "A 2" }).getAttribute("aria-current")).toBe(
      "page",
    );
    route.pathname = "/blog";
    rerender(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the menu when the viewport changes to desktop", async () => {
    const user = userEvent.setup();
    const listeners = new Set<() => void>();
    const desktop = {
      matches: false,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn<(query: string) => typeof desktop>(() => desktop),
    );
    render(
      <CartProvider storage={null}>
        <SiteHeader />
      </CartProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    expect(await screen.findByRole("dialog", { name: "Menu" })).toBeTruthy();
    act(() => {
      desktop.matches = true;
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Otevřít navigaci" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
