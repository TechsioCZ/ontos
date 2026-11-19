import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  CatalogHelpNavigation,
  CatalogNavigation,
  CatalogSidebar,
} from "@/components/catalog-sidebar";
import { cs } from "@/i18n/cs";
import { fixtureCatalog } from "../support/catalog-fixture";
import { renderStorefront } from "../support/storefront";

const { getSidebarCategories } = fixtureCatalog;

afterEach(cleanup);

describe("CatalogSidebar", () => {
  it("opens the special section and both catalog roots without expanding deeper branches", () => {
    const categories = getSidebarCategories("a-2-141");
    renderStorefront(<CatalogSidebar categories={categories} />);

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
      within(navigation).getByRole("link", { name: "AKROSCZ Výroba" }).getAttribute("href"),
    ).toBe("https://www.akroscz.cz/");
    expect(within(navigation).queryByText("Speciální spojovací materiál")).toBeNull();
  });

  it("supports compact collapsed roots in the shared mobile navigation", async () => {
    const user = userEvent.setup();
    const categories = getSidebarCategories();
    renderStorefront(
      <>
        <CatalogNavigation
          categories={categories}
          expandRoots={false}
          navigationId="catalog-mobile"
        />
        <CatalogHelpNavigation />
      </>,
    );
    const mobileNavigation = screen.getByRole("navigation", { name: cs.catalog.title });
    expect(
      within(screen.getByRole("navigation", { name: cs.catalog.recommendations }))
        .getByRole("link", { name: cs.catalog.firstSteps })
        .getAttribute("href"),
    ).toBe("/cs/faq");
    expect(
      within(mobileNavigation)
        .getByRole("button", { name: cs.catalog.specialCategories })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    for (const category of categories.filter((category) => category.parentId === null)) {
      expect(
        within(mobileNavigation)
          .getByRole("button", { name: category.name })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    }
    const trigger = within(mobileNavigation).getByRole("button", {
      name: categories.find((category) => category.parentId === null)!.name,
    });
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the active category trail and marks only its leaf as current", () => {
    renderStorefront(
      <CatalogSidebar activeSlug="a-2-141" categories={getSidebarCategories("a-2-141")} />,
    );

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const currentLink = within(desktopNavigation).getByRole("link", { name: "A 2" });
    const expandedBranches = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-expanded") === "true");

    expect(currentLink.getAttribute("aria-current")).toBe("page");
    expect(expandedBranches).toHaveLength(6);
    expect(desktopNavigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("allows a root branch to collapse and reopen", async () => {
    const user = userEvent.setup();
    const { container } = renderStorefront(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = within(container).getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const rootLink = desktopNavigation.querySelector<HTMLAnchorElement>(
      'a[href="/cs/kategorie/nerezovy-spojovaci-material"]',
    );
    const rootRow = rootLink?.closest('[data-part="row"]');
    if (!(rootRow instanceof HTMLElement)) throw new Error("Catalog root row is missing");
    const trigger = within(rootRow).getByRole("button");

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));

    await user.click(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  });

  it("shows that a collapsed category has children before its branch is loaded", () => {
    renderStorefront(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const categoryLink = desktopNavigation.querySelector<HTMLAnchorElement>(
      'a[href="/cs/kategorie/koliky"]',
    );
    const categoryRow = categoryLink?.closest('[data-part="row"]');

    expect(categoryRow).not.toBeNull();
    if (!(categoryRow instanceof HTMLElement)) throw new Error("Category row is missing");
    expect(categoryRow.querySelector("[data-sf-branch-indicator]")).not.toBeNull();
  });
});
