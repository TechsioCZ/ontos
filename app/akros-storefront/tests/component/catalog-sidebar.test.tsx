import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { cs } from "@/i18n/cs";

describe("CatalogSidebar", () => {
  it("opens the active category trail and marks only its leaf as current", () => {
    render(<CatalogSidebar activeSlug="din-933-a2" />);

    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: cs.catalog.title,
    });
    const currentLink = within(desktopNavigation).getByRole("link", { name: "A2" });
    const expandedBranches = within(desktopNavigation)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-expanded") === "true");

    expect(currentLink.getAttribute("aria-current")).toBe("page");
    expect(expandedBranches).toHaveLength(5);
  });
});
