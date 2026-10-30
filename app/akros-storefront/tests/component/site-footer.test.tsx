import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SiteFooter } from "@/components/site-footer";
import { cs } from "@/i18n/cs";

afterEach(cleanup);

describe("SiteFooter", () => {
  it("renders the complete Figma footer with customer, payment and carrier information", () => {
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
    expect(footer.querySelector(".token-icon-akros-facebook")).toBeTruthy();
    expect(footer.querySelector(".token-icon-akros-instagram")).toBeTruthy();
    expect(footer.querySelector(".token-icon-akros-youtube")).toBeTruthy();

    for (const [name, href] of [
      ["Facebook", "https://fb.com"],
      ["Instagram", "https://instagram.com"],
      ["YouTube", "https://youtube.com"],
    ]) {
      const link = within(footer).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }

    for (const assetName of [
      cs.footer.paymentCard,
      "Google Pay",
      "Apple Pay",
      "Zásilkovna",
      "PPL",
      "GLS",
      "DPD",
      "Balíkovna",
      "Verified by Visa",
      "Mastercard SecureCode",
    ]) {
      expect(within(footer).getByRole("img", { name: assetName })).toBeTruthy();
    }

    expect(within(footer).getByRole("link", { name: cs.footer.cookies }).getAttribute("href")).toBe(
      "/gdpr#cookies",
    );
    expect(within(footer).queryByAltText("Partnerský program AKROS")).toBeNull();
  });
});
