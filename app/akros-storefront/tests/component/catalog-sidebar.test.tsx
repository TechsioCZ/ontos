import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { cs } from "@/i18n/cs";
import { getSidebarCategories } from "@/mock-storefront/catalog";

afterEach(cleanup);

describe("CatalogSidebar", () => {
  it("opens the special section and both catalog roots without expanding deeper branches", () => {
    const categories = getSidebarCategories("a-2-141");
    render(<CatalogSidebar categories={categories} />);

    const [navigation] = screen.getAllByRole("navigation", { name: cs.catalog.title });
    const rootCategories = categories.filter((category) => category.parentId === null);

    expect(rootCategories).toHaveLength(2);
    expect(
      within(navigation)
        .getByRole("button", { name: cs.catalog.specialCategories })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    for (const category of rootCategories) {
      expect(
        within(navigation)
          .getByRole("button", { name: category.name })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    }
    expect(
      within(navigation).getByRole("button", { name: "Vruty" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      within(navigation).getByRole("link", { name: cs.catalog.production }).getAttribute("href"),
    ).toBe("https://www.akroscz.cz/");
    expect(within(navigation).queryByText("Speciální spojovací materiál")).toBeNull();
  });

  it("keeps the mobile catalog closed while its root categories are ready to browse", async () => {
    const user = userEvent.setup();
    const categories = getSidebarCategories();
    render(<CatalogSidebar categories={categories} />);

    const summary = screen.getByText(cs.catalog.title, { selector: "summary" });
    const mobileCatalog = summary.closest("details");
    expect(mobileCatalog?.open).toBe(false);

    await user.click(summary);

    expect(mobileCatalog?.open).toBe(true);
    const navigations = screen.getAllByRole("navigation", { name: cs.catalog.title });
    expect(navigations).toHaveLength(2);
    const mobileNavigation = navigations[1];
    expect(
      within(mobileNavigation)
        .getByRole("button", { name: cs.catalog.specialCategories })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    for (const category of categories.filter((category) => category.parentId === null)) {
      expect(
        within(mobileNavigation)
          .getByRole("button", { name: category.name })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    }
  });

  it("uses the subtle catalog surface without the redundant introduction", () => {
    render(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });

    expect(screen.queryByRole("heading", { name: cs.catalog.title })).toBeNull();
    expect(screen.queryByText(cs.catalog.description)).toBeNull();
    expect(desktopNavigation.querySelector('[data-part="group"]')?.getAttribute("data-tone")).toBe(
      "subtle",
    );
  });

  it("opens the active category trail and marks only its leaf as current", () => {
    render(<CatalogSidebar activeSlug="a-2-141" categories={getSidebarCategories("a-2-141")} />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const currentLink = within(desktopNavigation).getByRole("link", { name: "A 2" });
    const rootLink = desktopNavigation.querySelector<HTMLAnchorElement>(
      'a[href="/kategorie/nerezovy-spojovaci-material"]',
    );
    const expandedBranches = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-expanded") === "true");

    expect(currentLink.getAttribute("aria-current")).toBe("page");
    expect(currentLink.getAttribute("data-akros-depth")).toBe("4");
    expect(rootLink?.closest('[data-part="row"]')?.getAttribute("data-akros-depth")).toBe("0");
    expect(expandedBranches).toHaveLength(6);
    expect(desktopNavigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("allows a root branch to collapse and reopen with its existing background tone", async () => {
    const user = userEvent.setup();
    const { container } = render(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = within(container).getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const rootLink = desktopNavigation.querySelector<HTMLAnchorElement>(
      'a[href="/kategorie/nerezovy-spojovaci-material"]',
    );
    const rootRow = rootLink?.closest('[data-part="row"]');
    const trigger = within(rootRow as HTMLElement).getByRole("button");

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));

    await user.click(trigger);

    await waitFor(() => {
      expect(
        desktopNavigation.querySelector(
          '[data-part="branch"][data-state="open"] > [data-akros-depth="0"]',
        ),
      ).not.toBeNull();
    });
  });

  it("shows that a collapsed category has children before its branch is loaded", () => {
    render(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const categoryLink = desktopNavigation.querySelector<HTMLAnchorElement>(
      'a[href="/kategorie/koliky"]',
    );
    const categoryRow = categoryLink?.closest('[data-part="row"]');

    expect(categoryRow).not.toBeNull();
    expect(categoryRow?.querySelector("[data-akros-branch-indicator]")).not.toBeNull();
  });
});
