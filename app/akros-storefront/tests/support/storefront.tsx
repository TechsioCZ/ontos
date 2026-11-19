import { render, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { BrandProvider } from "@/brand/brand-context";
import { akros } from "@/brand/akros";
import { toClientBrand } from "@/brand";
import { CatalogProvider } from "@/ontos/catalog-provider";
import { MarketProvider, type ClientMarket } from "@/ontos/market-context";
import { fixtureProducts, fixtureCategories } from "./catalog-fixture";
import { testMarket } from "./market-fixture";

export const fixtureSnapshot = {
  catalog: { products: fixtureProducts, homepageFeaturedProductIds: [] },
  categories: { categories: fixtureCategories },
};
export function StorefrontProviders({
  children,
  market = { ...testMarket, live: [] },
}: {
  children: ReactNode;
  market?: ClientMarket;
}) {
  return (
    <MarketProvider market={market}>
      <BrandProvider brand={toClientBrand(akros, market.locale)}>
        <CatalogProvider snapshot={fixtureSnapshot}>{children}</CatalogProvider>
      </BrandProvider>
    </MarketProvider>
  );
}

export function renderStorefront(ui: ReactNode, options?: RenderOptions) {
  return render(ui, { wrapper: StorefrontProviders, ...options });
}
