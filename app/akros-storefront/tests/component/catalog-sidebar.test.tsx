import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  CatalogHelpNavigation,
  CatalogNavigation,
  CatalogSidebar,
} from "@/components/catalog-sidebar";
import { cs } from "@/i18n/cs";
import { createCatalog } from "@/ontos/catalog-model";
import { projectCategories } from "@/ontos/catalog-projection";
import { renderStorefront } from "../support/storefront";

const category = (slug: string, name: string, parentId: string | null) => ({
  id: slug,
  slug,
  name,
  parentId,
});
const { getSidebarCategories } = createCatalog(
  { products: [], homepageFeaturedProductIds: [] },
  {
    categories: projectCategories({
      categories: [
        category("nerezovy-spojovaci-material", "Nerezový spojovací materiál", null),
        category("vruty", "Vruty", "nerezovy-spojovaci-material"),
        category("vruty-do-dreva", "Vruty do dřeva", "vruty"),
        category("din-7997", "DIN 7997", "vruty-do-dreva"),
        category("a-2-141", "A 2", "din-7997"),
        category("koliky", "Kolíky", "nerezovy-spojovaci-material"),
        category("specialni", "Speciální spojovací materiál", "koliky"),
        category("plechy", "Plechy", null),
        category("plech-a2", "A 2", "plechy"),
        category("naradi", "Nářadí", null),
      ],
    }),
  },
);

afterEach(cleanup);

describe("CatalogSidebar", () => {
  it("opens the special section and both root branches without expanding deeper branches", () => {
    const categories = getSidebarCategories("a-2-141");
    renderStorefront(<CatalogSidebar categories={categories} />);

    const [navigation] = screen.getAllByRole("navigation", { name: cs.catalog.title });

    expect(
      within(navigation)
        .getByRole("button", { name: cs.catalog.specialCategories })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    for (const name of ["Nerezový spojovací materiál", "Plechy"]) {
      expect(within(navigation).getByRole("button", { name }).getAttribute("aria-expanded")).toBe(
        "true",
      );
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
    for (const name of ["Nerezový spojovací materiál", "Plechy"]) {
      expect(
        within(mobileNavigation).getByRole("button", { name }).getAttribute("aria-expanded"),
      ).toBe("false");
    }
    expect(
      within(mobileNavigation).getByRole("link", { name: "Nářadí" }).getAttribute("href"),
    ).toBe("/cs/kategorie/naradi");
    expect(within(mobileNavigation).queryByRole("button", { name: "Nářadí" })).toBeNull();
    const trigger = within(mobileNavigation).getByRole("button", {
      name: "Nerezový spojovací materiál",
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
    const currentLink = within(desktopNavigation).getByRole("link", {
      name: "A 2",
      current: "page",
    });
    const expandedBranches = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-expanded") === "true");

    expect(currentLink.getAttribute("href")).toBe("/cs/kategorie/a-2-141");
    expect(
      within(desktopNavigation)
        .getByRole("link", { name: "A 2", current: false })
        .getAttribute("href"),
    ).toBe("/cs/kategorie/plech-a2");
    expect(expandedBranches.map((branch) => branch.getAttribute("aria-label")).sort()).toEqual(
      [
        cs.catalog.specialCategories,
        "Nerezový spojovací materiál",
        "Plechy",
        "Vruty",
        "Vruty do dřeva",
        "DIN 7997",
      ].sort(),
    );
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
    const rootRow = rootLink?.closest<HTMLElement>('[data-part="row"]');
    if (!rootRow) throw new Error("Catalog root row is missing");
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
    const categoryRow = categoryLink?.closest<HTMLElement>('[data-part="row"]');

    expect(categoryRow).not.toBeNull();
    if (!categoryRow) throw new Error("Category row is missing");
    expect(categoryRow.querySelector("[data-sf-branch-indicator]")).not.toBeNull();
  });
});
