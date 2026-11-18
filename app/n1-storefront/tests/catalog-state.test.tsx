import { beforeEach, describe, expect, it } from "@rstest/core";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogState } from "../src/features/catalog-state";
import { getDictionary } from "../src/i18n";

const serverNavigation = () => {
  throw new Error("Navigation must not run during server rendering");
};
const router = {
  back: serverNavigation,
  bfcacheId: "catalog-state",
  forward: serverNavigation,
  prefetch: serverNavigation,
  push: serverNavigation,
  refresh: serverNavigation,
  replace: serverNavigation,
} satisfies AppRouterInstance;
const localeParams = { cs: { locale: "cs" }, en: { locale: "en" } };
let locale: keyof typeof localeParams = "cs";
const renderState = (kind: "category" | "product", pending: boolean) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathParamsContext.Provider value={localeParams[locale]}>
        <CatalogState kind={kind} pending={pending} />
      </PathParamsContext.Provider>
    </AppRouterContext.Provider>,
  );

describe("truthful product read loading", () => {
  beforeEach(() => {
    locale = "cs";
  });
  it("announces pending price and availability with a disabled neutral loading control", () => {
    const html = renderState("product", true);
    expect(html).toContain("Načítání ceny");
    expect(html).toContain("Načítání dostupnosti");
    // A loading ui-kit Button stays focusable: it is aria-disabled, not natively disabled.
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(getDictionary("cs").notifications.loading);
    expect(html).not.toContain(getDictionary("cs").addToCartDetail);
    expect(html).not.toContain("Kč");
  });
  it("localizes the outstanding reads without claiming an add-to-cart action", () => {
    locale = "en";
    const html = renderState("product", true);
    expect(html).toContain("Loading price");
    expect(html).toContain("Loading availability");
    expect(html).toContain(getDictionary("en").notifications.loading);
    expect(html).not.toContain(getDictionary("en").addToCartDetail);
  });
  it.each(["cs", "en"] as const)(
    "distinguishes failed product and category reads in %s",
    (language) => {
      locale = language;
      const d = getDictionary(language);
      const product = renderState("product", false);
      const category = renderState("category", false);
      expect(product).toContain(d.productLoadFailed);
      expect(product).not.toContain(d.categoryLoadFailed);
      expect(category).toContain(d.categoryLoadFailed);
      expect(category).not.toContain(d.productLoadFailed);
      for (const html of [product, category]) {
        expect(html).toContain(d.retry);
        expect(html).not.toContain(d.loadingPrice);
        expect(html).not.toContain('disabled=""');
      }
    },
  );
  it("does not replace the distinct category-loading state with product purchase placeholders", () => {
    const html = renderState("category", true);
    expect(html).toContain(getDictionary("cs").loadingCatalog);
    expect(html).not.toContain("Načítání ceny");
    expect(html).not.toContain("Načítání dostupnosti");
  });
});
