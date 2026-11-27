"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { loadFavoriteProduct } from "@/features/favorites/catalog";
import type { CatalogPurchaseVariant } from "@/ontos/catalog-types";

/** Every variant of a long table, fetched once on the shopper's first filter, page or detail action. */
export type ProductVariantList =
  | { status: "idle" | "loading" | "failed" }
  | { status: "ready"; variants: CatalogPurchaseVariant[] };

interface ProductVariantsValue {
  list: ProductVariantList;
  /** Starts the one read (again after a failure); a loading or loaded list is kept. */
  load: () => void;
}

const idle: ProductVariantsValue = { list: { status: "idle" }, load: () => {} };
const ProductVariantsContext = createContext<ProductVariantsValue>(idle);

/** One product page's variant list, shared by the variant table and the variant detail dialog. */
export function ProductVariantsProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [list, setList] = useState<ProductVariantList>({ status: "idle" });
  const load = useCallback(
    () =>
      setList((current) =>
        current.status === "loading" || current.status === "ready"
          ? current
          : { status: "loading" },
      ),
    [],
  );
  const loading = list.status === "loading";
  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    // The same public product read as favorites: the request market's current variants.
    loadFavoriteProduct(slug, controller.signal).then(
      ({ variants }) => setList({ status: "ready", variants }),
      () => {
        if (!controller.signal.aborted) setList({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [loading, slug]);
  const value = useMemo(() => ({ list, load }), [list, load]);
  return <ProductVariantsContext value={value}>{children}</ProductVariantsContext>;
}

export const useProductVariants = () => useContext(ProductVariantsContext);
