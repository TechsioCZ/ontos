import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SiteFooter } from "@/components/site-footer";
import { cs } from "@/i18n/cs";

afterEach(cleanup);

describe("SiteFooter", () => {
  it("shows actual contacts without unsupported payment, carrier or generic social claims", () => {
    render(<SiteFooter />);

    const footer = screen.getByRole("contentinfo");
    const customerNavigation = within(footer).getByRole("navigation", {
      name: cs.footer.customerInformation,
    });

    expect(within(footer).getByRole("img", { name: "AKROS" })).toBeTruthy();
    expect(within(footer).getByRole("link", { name: "737 591 849" }).getAttribute("href")).toBe(
      "tel:+420737591849",
    );
    expect(within(footer).getByRole("link", { name: "akros@akros.cz" }).getAttribute("href")).toBe(
      "mailto:akros@akros.cz",
    );
    expect(
      within(customerNavigation).getByRole("link", { name: cs.footer.claims }).getAttribute("href"),
    ).toBe("/reklamace");
    expect(
      within(customerNavigation)
        .getByRole("link", { name: cs.footer.downloads })
        .getAttribute("href"),
    ).toBe("/faq");

    expect(within(footer).getByRole("img", { name: cs.footer.heurekaBadge })).toBeTruthy();
    for (const name of ["Facebook", "Instagram", "YouTube"]) {
      expect(within(footer).queryByRole("link", { name })).toBeNull();
    }
    for (const name of [
      cs.footer.paymentCard,
      "Google Pay",
      "Apple Pay",
      "Verified by Visa",
      "Mastercard SecureCode",
    ]) {
      expect(within(footer).queryByRole("img", { name })).toBeNull();
    }

    expect(within(footer).getByRole("link", { name: cs.footer.cookies }).getAttribute("href")).toBe(
      "/gdpr#cookies",
    );
    expect(within(footer).queryByAltText("Partnerský program AKROS")).toBeNull();
  });
});
