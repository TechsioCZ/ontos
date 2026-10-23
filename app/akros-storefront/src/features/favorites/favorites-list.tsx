"use client";

import NextLink from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { getProductStockStatus } from "@/lib/product-stock";
import { buildVariantSelectionHref } from "@/lib/product-variant-links";
import { loadFavoriteProduct, type FavoriteCatalogProduct } from "./catalog";
import { saveProductFavorites, useFavorites } from "./use-favorites";

export function FavoritesList() {
  const { favorites, ready, available } = useFavorites();
  const [catalog, setCatalog] = useState<FavoriteCatalogProduct[]>([]);
  const [loadedKey, setLoadedKey] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const slugsKey = JSON.stringify([...new Set(favorites.map((item) => item.productSlug))]);
  useEffect(() => {
    const controller = new AbortController();
    const slugs: string[] = JSON.parse(slugsKey);
    Promise.allSettled(slugs.map((slug) => loadFavoriteProduct(slug, controller.signal))).then(
      (results) => {
        if (controller.signal.aborted) return;
        setCatalog(
          results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
        );
        setLoadedKey(slugsKey);
      },
    );
    return () => controller.abort();
  }, [slugsKey, attempt]);
  const products: ProductGridItem[] = [];
  const missing = [];
  for (const reference of favorites) {
    const entry = catalog.find((item) => item.product.id === reference.productId);
    const variant = entry?.variants.find(
      (item) => item.id === (reference.variantId ?? reference.productId),
    );
    if (!entry || !variant) {
      missing.push(reference);
      continue;
    }
    products.push({
      ...entry.product,
      name: entry.product.hasVariants ? variant.label : entry.product.name,
      productName: entry.product.name,
      sku: variant.sku,
      description: `Kód varianty: ${variant.sku}`,
      variantId: reference.variantId ?? undefined,
      favoriteVariantId: reference.variantId,
      variantLabel: variant.label,
      imageSrc: variant.imageSrc ?? entry.product.imageSrc,
      priceMinor: variant.priceMinor,
      originalPriceMinor: variant.originalPriceMinor,
      priceExcludingVatMinor: variant.priceTiers.find(
        (tier) => tier.priceMinor === variant.priceMinor,
      )?.priceExcludingVatMinor,
      hasVariants: false,
      priceIsFrom: false,
      detailHref: buildVariantSelectionHref(
        entry.product.slug,
        reference.variantId ? [reference.variantId] : [],
      ),
      stock: {
        kind: "quantity",
        status: getProductStockStatus(variant),
        stockCount: variant.stockCount,
        minimumQuantity: variant.minimumQuantity,
        packageQuantity: variant.packageQuantity,
        unit: variant.unit,
      },
      isAction: variant.isAction,
      isRecommended: variant.isRecommended,
      isSale: variant.isSale,
      isNew: variant.isNew,
    });
  }
  if (!ready || (favorites.length > 0 && loadedKey !== slugsKey))
    return <output>Načítám oblíbené varianty…</output>;
  if (!available)
    return (
      <p role="alert">
        Oblíbené nelze načíst. Povolte místní úložiště prohlížeče a obnovte stránku.
      </p>
    );
  if (!favorites.length)
    return (
      <div data-favorites-empty>
        <p>Zatím nemáte uloženou žádnou oblíbenou variantu.</p>
        <LinkButton as={NextLink} href="/" size="md" variant="primary">
          Prohlédnout produkty
        </LinkButton>
      </div>
    );
  return (
    <div data-account-products>
      <output>Uloženo variant: {favorites.length}. Seznam je uložený v tomto prohlížeči.</output>
      {message && <p role="alert">{message}</p>}
      {products.length > 0 && <ProductGrid products={products} columns="checkout" />}
      {missing.length > 0 && (
        <section aria-label="Nenačtené oblíbené varianty">
          <p>Některé varianty se nepodařilo načíst nebo už nejsou v katalogu.</p>
          <Button
            size="md"
            variant="secondary"
            theme="outlined"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Zkusit načíst znovu
          </Button>
          {missing.map((item) => (
            <div className="akros-favorites-missing" key={`${item.productId}:${item.variantId}`}>
              <span>
                Produkt {item.productId}, varianta {item.variantId ?? "samostatná položka"}
              </span>
              <Button
                size="sm"
                theme="outlined"
                variant="secondary"
                onClick={() => {
                  try {
                    saveProductFavorites(
                      item.productId,
                      favorites.filter(
                        (saved) =>
                          saved.productId === item.productId && saved.variantId !== item.variantId,
                      ),
                    );
                    setMessage("");
                  } catch {
                    setMessage("Variantu se nepodařilo odebrat. Zkuste to znovu.");
                  }
                }}
              >
                Odebrat z oblíbených
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
