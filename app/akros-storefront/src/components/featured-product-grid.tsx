"use client";

import { ProductGrid } from "@/components/product-grid";
import type { CatalogProductSummary } from "@/mock-storefront/types";

export function FeaturedProductGrid({ products }: { products: CatalogProductSummary[] }) {
  return <ProductGrid action="detail" columns="featured" products={products} />;
}
