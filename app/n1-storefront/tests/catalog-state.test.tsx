import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogState } from "../src/features/catalog-state";
import { getDictionary } from "../src/i18n";

const navigation = rs.hoisted(() => ({ locale: "cs", refresh: rs.fn() }));
rs.mock("next/navigation", () => ({
  useParams: () => ({ locale: navigation.locale }),
  useRouter: () => ({ refresh: navigation.refresh }),
}));

const renderState = (kind: "category" | "product", pending: boolean) =>
  renderToStaticMarkup(createElement(CatalogState, { kind, pending }));

beforeEach(() => {
  navigation.locale = "cs";
});

describe("truthful product read loading", () => {
  it("announces pending price and availability with a disabled neutral loading control", () => {
    const html = renderState("product", true);
    expect(html).toContain("Načítání ceny");
    expect(html).toContain("Načítání dostupnosti");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(getDictionary("cs").notifications.loading);
    expect(html).not.toContain(getDictionary("cs").addToCartDetail);
    expect(html).not.toContain("Kč");
  });
  it("localizes the outstanding reads without claiming an add-to-cart action", () => {
    navigation.locale = "en";
    const html = renderState("product", true);
    expect(html).toContain("Loading price");
    expect(html).toContain("Loading availability");
    expect(html).toContain(getDictionary("en").notifications.loading);
    expect(html).not.toContain(getDictionary("en").addToCartDetail);
  });
  it("retains real unavailable/retry semantics instead of showing pending data", () => {
    const html = renderState("product", false);
    expect(html).toContain(getDictionary("cs").productUnavailable);
    expect(html).toContain(getDictionary("cs").retry);
    expect(html).not.toContain("Načítání ceny");
    expect(html).not.toContain('disabled=""');
  });
  it("uses the product error from Figma instead of the catalogue failure", () => {
    const html = renderState("product", false);
    expect(html).toContain("Produkt se nepodařilo načíst.");
    expect(html).not.toContain(getDictionary("cs").unavailableDescription);
    expect(renderState("category", false)).toContain(
      "Produkty se nepodařilo načíst. Zkuste to prosím znovu.",
    );
  });
  it("localizes the product failure separately from the catalogue failure", () => {
    navigation.locale = "en";
    const html = renderState("product", false);
    expect(html).toContain("The product could not be loaded.");
    expect(html).not.toContain(getDictionary("en").unavailableDescription);
    expect(renderState("category", false)).toContain(
      "The products could not be loaded. Please try again.",
    );
  });
  it("does not replace the distinct category-loading state with product purchase placeholders", () => {
    const html = renderState("category", true);
    expect(html).toContain(getDictionary("cs").loadingCatalog);
    expect(html).not.toContain("Načítání ceny");
    expect(html).not.toContain("Načítání dostupnosti");
  });
});
