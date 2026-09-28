import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { cs } from "@/i18n/cs";
import { getSidebarCategories } from "@/mock-storefront/catalog";

describe("CatalogSidebar", () => {
  it("opens the active category trail and marks only its leaf as current", () => {
    render(<CatalogSidebar activeSlug="a-2-141" categories={getSidebarCategories("a-2-141")} />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const currentLink = within(desktopNavigation).getByRole("link", { name: "A 2" });
    const expandedBranches = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-expanded") === "true");

    expect(currentLink.getAttribute("aria-current")).toBe("page");
    expect(currentLink.getAttribute("data-akros-depth")).toBe("4");
    expect(
      within(desktopNavigation)
        .getByRole("link", { name: "Nerezový spojovací materiál" })
        .closest('[data-part="row"]')
        ?.getAttribute("data-akros-depth"),
    ).toBe("0");
    expect(expandedBranches).toHaveLength(4);
  });

  it("exposes the depth of a manually opened branch for its background tone", async () => {
    const user = userEvent.setup();
    const { container } = render(<CatalogSidebar categories={getSidebarCategories()} />);

    const [desktopNavigation] = within(container).getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const trigger = within(desktopNavigation).getByRole("button", {
      name: "Nerezový spojovací materiál",
    });

    await user.click(trigger);

    await waitFor(() => {
      expect(
        desktopNavigation.querySelector(
          '[data-part="branch"][data-state="open"] > [data-akros-depth="0"]',
        ),
      ).not.toBeNull();
    });
  });
});
