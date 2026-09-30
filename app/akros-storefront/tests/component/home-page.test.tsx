import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "@/app/page";

vi.mock("@/components/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/home-carousel", () => ({ HomeCarousel: () => null }));
vi.mock("@/components/featured-product-grid", () => ({ FeaturedProductGrid: () => null }));

describe("HomePage company introduction", () => {
  it("renders four plain paragraphs with the emphasis from the redesign", () => {
    render(<HomePage />);

    const introduction = screen.getByRole("region", { name: "O společnosti AKROS" });
    const paragraphs = introduction.querySelectorAll("p");

    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0].textContent).toContain("Vítejte v internetovém obchodě společnosti AKROS");
    expect(paragraphs[1].textContent).toContain("rozšiřovat sortiment o nové produkty");
    expect(paragraphs[2].textContent).toContain("výrobou na zakázku");
    expect(paragraphs[3].textContent).toContain("prostor k pohodlným nákupům.");
    expect([...introduction.querySelectorAll("strong")].map((part) => part.textContent)).toEqual([
      "nerezových spojovacích materiálů",
      "nerezový hutní materiál",
      "rozšiřovat sortiment o nové produkty",
      "seriovou zámečnickou výrobou i výrobou na zakázku",
      "výrobky z nerezové oceli",
      "schodiště",
    ]);
    expect(within(introduction).queryByRole("heading")).toBeNull();
    expect(introduction.classList.contains("akros-company-intro")).toBe(false);
    expect(introduction.classList.contains("text-sm")).toBe(true);
  });
});
