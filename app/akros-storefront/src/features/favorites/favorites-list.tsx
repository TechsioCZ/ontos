"use client";

import { useEffect, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import StoreLink from "@/components/store-link";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { getProductStockStatus } from "@/lib/product-stock";
import { buildVariantSelectionHref } from "@/lib/product-variant-links";
import { useDictionary } from "@/ontos/market-context";
import { loadFavoriteProduct, type FavoriteCatalogProduct } from "./catalog";
import { saveProductFavorites, useFavorites } from "./use-favorites";

/** Browser-saved favorite references resolved against the live OntOS catalogue of the current market. */
export function FavoritesList() {
  const cs = useDictionary();
  const { favorites, ready, available } = useFavorites();
  const [catalog, setCatalog] = useState<FavoriteCatalogProduct[]>([]);
  const [loadedKey, setLoadedKey] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const slugsKey = JSON.stringify([...new Set(favorites.map((item) => item.productSlug))]);
  useEffect(() => {
    const controller = new AbortController();
    const slugs: string[] = JSON.parse(slugsKey);
    void Promise.allSettled(slugs.map((slug) => loadFavoriteProduct(slug, controller.signal))).then(
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
      description: cs.favorites.variantSku(variant.sku),
      variantId: reference.variantId ?? undefined,
      favoriteVariantId: reference.variantId,
      variantLabel: variant.label,
      imageSrc: variant.imageSrc ?? entry.product.imageSrc,
      priceMinor: variant.priceMinor,
      originalPriceMinor: variant.originalPriceMinor,
      priceExcludingVatMinor: variant.priceTiers.find(
        (tier) => tier.priceMinor === variant.priceMinor,
      )?.priceExcludingVatMinor,
      availabilityUnknown: variant.availabilityUnknown,
      priceUnavailableReason: variant.priceUnavailableReason,
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
        quantityStep: variant.quantityStep,
        unit: variant.unit,
      },
      isAction: variant.isAction,
      isRecommended: variant.isRecommended,
      isSale: variant.isSale,
      isNew: variant.isNew,
    });
  }
  if (!ready || (favorites.length > 0 && loadedKey !== slugsKey))
    return <output>{cs.favorites.loading}</output>;
  if (!available) return <p role="alert">{cs.favorites.unavailable}</p>;
  if (!favorites.length)
    return (
      <div data-favorites-empty>
        <p>{cs.favorites.empty}</p>
        <LinkButton as={StoreLink} href="/" size="md" variant="primary">
          {cs.favorites.browse}
        </LinkButton>
      </div>
    );
  return (
    <div data-account-products>
      <output>{cs.favorites.savedCount(favorites.length)}</output>
      {message && <p role="alert">{message}</p>}
      {products.length > 0 && <ProductGrid products={products} columns="checkout" />}
      {missing.length > 0 && (
        <section aria-label={cs.favorites.missing}>
          <p>{cs.favorites.missingText}</p>
          <Button
            size="md"
            variant="secondary"
            theme="outlined"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {cs.favorites.retry}
          </Button>
          {missing.map((item) => (
            <div className="sf-favorites-missing" key={`${item.productId}:${item.variantId}`}>
              <span>
                {cs.favorites.missingItem(
                  item.productId,
                  item.variantId ?? cs.favorites.standaloneItem,
                )}
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
                    setMessage(cs.favorites.removeFailed);
                  }
                }}
              >
                {cs.favorites.removeAction}
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
