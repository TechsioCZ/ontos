import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogPagination } from "@/components/catalog-pagination";

afterEach(cleanup);

describe("CatalogPagination", () => {
  it("scopes the mobile layout while preserving category page links", () => {
    const { container } = render(
      <CatalogPagination
        currentPage={1}
        itemCount={300}
        pageSize={24}
        pathname="/kategorie/matice"
      />,
    );

    expect(container.firstElementChild?.classList.contains("akros-catalog-pagination")).toBe(true);
    expect(container.querySelector('a[href="/kategorie/matice?page=2"]')).toBeTruthy();
    expect(screen.getByRole("navigation").getAttribute("aria-label")).toBeTruthy();
  });

  it("preserves the search query when navigating result pages", () => {
    const { container } = render(
      <CatalogPagination
        currentPage={2}
        itemCount={300}
        pageSize={24}
        pathname="/vyhledavani"
        searchParams={{ q: "matice" }}
      />,
    );

    expect(container.querySelector('a[href="/vyhledavani?q=matice&page=3"]')).toBeTruthy();
    expect(container.querySelector('a[href="/vyhledavani?q=matice"]')).toBeTruthy();
  });

  it("does not render pagination for a single result page", () => {
    render(
      <CatalogPagination
        currentPage={1}
        itemCount={12}
        pageSize={24}
        pathname="/kategorie/matice"
      />,
    );

    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
