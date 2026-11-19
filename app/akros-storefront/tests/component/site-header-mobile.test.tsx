import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CartProvider } from "@/features/cart/cart-provider";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderStorefront } from "../support/storefront";
import { browserAt, serveHttp } from "../support/http";

// Menu tests supply Next's actual contexts; search navigation is outside these cases.
function unexpectedNavigation(): never {
  throw new Error("Unexpected search navigation in mobile menu test");
}
const router = {
  bfcacheId: "mobile-menu",
  back: unexpectedNavigation,
  forward: unexpectedNavigation,
  refresh: unexpectedNavigation,
  push: unexpectedNavigation,
  replace: unexpectedNavigation,
  prefetch: unexpectedNavigation,
};

let network: Awaited<ReturnType<typeof serveHttp>>;

beforeEach(async () => {
  network = await serveHttp(
    () =>
      new Response("<!doctype html><title>Blog</title>", {
        headers: { "content-type": "text/html" },
      }),
  );
  browserAt(`${network.origin}/cs`);
  window.happyDOM.setViewport({ width: 390, height: 844 });
});

afterEach(async () => {
  cleanup();
  await network.close();
});

function header(pathname = "/cs") {
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <CartProvider storage={null}>
          <SiteHeader />
        </CartProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

describe("SiteHeader mobile navigation", () => {
  it("opens one modal with catalog, account and information links, then restores focus", async () => {
    const user = userEvent.setup();
    renderStorefront(header());
    const trigger = screen.getByRole("button", { name: "Otevřít navigaci" });
    expect(trigger.textContent?.trim()).toBe("");
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
    ).toBe("/cs/kategorie/nerezovy-spojovaci-material");
    for (const [name, href] of [
      ["Přihlášení", "/cs/prihlaseni"],
      ["Můj účet", "/cs/muj-ucet"],
      ["Oblíbené", "/cs/oblibene"],
      ["Kontakty", "/cs/kontakty"],
    ]) {
      expect(within(dialog).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps category toggles inside the panel and closes it on navigation, including the current URL", async () => {
    const user = userEvent.setup();
    browserAt(`${network.origin}/cs/blog`);
    renderStorefront(header("/cs/blog"));
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const branch = within(dialog).getByRole("button", { name: "Nerezový spojovací materiál" });
    expect(branch.getAttribute("aria-expanded")).toBe("false");
    await user.click(branch);
    expect(branch.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog")).toBe(dialog);

    await user.click(within(dialog).getByRole("link", { name: "Blog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the active category trail and closes on a route change", async () => {
    const user = userEvent.setup();
    const { rerender } = renderStorefront(header("/cs/kategorie/a-2-141"));
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(dialog).getByRole("link", { name: "A 2" }).getAttribute("aria-current")).toBe(
      "page",
    );
    rerender(header("/cs/blog"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the menu when the viewport changes to desktop", async () => {
    const user = userEvent.setup();
    renderStorefront(header());
    await user.click(screen.getByRole("button", { name: "Otevřít navigaci" }));
    expect(await screen.findByRole("dialog", { name: "Menu" })).toBeTruthy();
    act(() => {
      window.happyDOM.setViewport({ width: 1280, height: 844 });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Otevřít navigaci" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
