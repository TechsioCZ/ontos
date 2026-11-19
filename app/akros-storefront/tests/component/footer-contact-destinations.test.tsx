import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SiteFooter } from "@/components/site-footer";
import { renderStorefront } from "../support/storefront";

afterEach(cleanup);

describe("Footer contact destinations", () => {
  it("pairs the visible AKROS phone number with its telephone destination", () => {
    renderStorefront(<SiteFooter />);

    expect(
      within(screen.getByRole("contentinfo"))
        .getByRole("link", { name: "737 591 849", exact: true })
        .getAttribute("href"),
    ).toBe("tel:+420737591849");
  });

  it("pairs the visible AKROS email address with its mail destination", () => {
    renderStorefront(<SiteFooter />);

    expect(
      within(screen.getByRole("contentinfo"))
        .getByRole("link", { name: "akros@akros.cz", exact: true })
        .getAttribute("href"),
    ).toBe("mailto:akros@akros.cz");
  });

  it("takes customer-information claims navigation to the claims page", () => {
    renderStorefront(<SiteFooter />);

    const navigation = within(screen.getByRole("contentinfo")).getByRole("navigation", {
      name: "Informace pro zákazníky",
    });
    expect(
      within(navigation).getByRole("link", { name: "Reklamační řád" }).getAttribute("href"),
    ).toBe("/cs/reklamace");
  });

  it("takes customer-information downloads navigation to the FAQ", () => {
    renderStorefront(<SiteFooter />);

    const navigation = within(screen.getByRole("contentinfo")).getByRole("navigation", {
      name: "Informace pro zákazníky",
    });
    expect(
      within(navigation).getByRole("link", { name: "Návody ke stažení" }).getAttribute("href"),
    ).toBe("/cs/faq");
  });

  it("takes the footer cookies link to the privacy page cookies section", () => {
    renderStorefront(<SiteFooter />);

    expect(
      within(screen.getByRole("contentinfo"))
        .getByRole("link", { name: "Cookies", exact: true })
        .getAttribute("href"),
    ).toBe("/cs/gdpr#cookies");
  });
});
