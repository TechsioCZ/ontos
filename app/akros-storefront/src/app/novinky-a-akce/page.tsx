import type { Metadata } from "next";
import Image from "next/image";
import NextLink from "next/link";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getNewProducts, getPromotionItems, toProductSummary } from "@/mock-storefront/catalog";
import { getProductStockStatus } from "@/lib/product-stock";

export const metadata: Metadata = { title: "Novinky a akce" };

const isGenericPromotionGroup = (name: string) => name.trim().toLocaleUpperCase("cs-CZ") === "AKCE";

export default function NewsPage() {
  const promotedItems = getPromotionItems()
    .filter(({ product }) => !isGenericPromotionGroup(product.name))
    .filter(({ product, variant }) => {
      const priceMinor = variant?.priceMinor ?? product.priceMinor;
      const minimumQuantity = variant?.minimumQuantity ?? product.minimumQuantity;
      const stockCount = variant?.stockCount ?? product.stockCount;

      return priceMinor > 0 && stockCount >= minimumQuantity;
    })
    .filter(
      ({ product }, index, items) =>
        items.findIndex((candidate) => candidate.product.id === product.id) === index,
    )
    .sort((left, right) => Number(right.kind === "sale") - Number(left.kind === "sale"))
    .slice(0, 4);
  const promotedProductIds = new Set(promotedItems.map(({ product }) => product.id));
  const newProducts = getNewProducts()
    .filter(
      (product) => !promotedProductIds.has(product.id) && !isGenericPromotionGroup(product.name),
    )
    .slice(0, 4);
  const promotionProducts: ProductGridItem[] = promotedItems.map(({ product, variant }) => {
    const summary = toProductSummary(product);
    if (!variant) return summary;

    return {
      ...summary,
      variantId: variant.id,
      variantLabel: variant.label,
      productName: product.name,
      name: variant.label,
      sku: variant.sku,
      detailHref: `/produkt/${product.slug}?variant=${encodeURIComponent(variant.sku)}`,
      imageSrc: variant.imageSrc ?? product.imageSrc,
      imageAlt: variant.label,
      priceMinor: variant.priceMinor,
      priceExcludingVatMinor: variant.priceTiers.find(
        (tier) => tier.priceMinor === variant.priceMinor,
      )?.priceExcludingVatMinor,
      originalPriceMinor: variant.originalPriceMinor,
      priceIsFrom: false,
      hasVariants: false,
      isAction: variant.isAction,
      isSale: variant.isSale,
      isRecommended: variant.isRecommended,
      isNew: variant.isNew,
      stock: {
        kind: "quantity",
        status: getProductStockStatus(variant),
        minimumQuantity: variant.minimumQuantity,
        packageQuantity: variant.packageQuantity,
        stockCount: variant.stockCount,
        unit: variant.unit,
      },
    };
  });

  return (
    <StorefrontWideShell>
      <article className="akros-news-page">
        <header className="akros-news-hero">
          <Image
            alt="Imbusové šrouby v automatizované výrobě"
            fill
            loading="eager"
            priority
            sizes="100vw"
            src="/akros/content/news-hero.png"
          />
          <div className="akros-news-hero__overlay">
            <div>
              <Badge size="sm" variant="danger">
                NABÍDKA Z KATALOGU
              </Badge>
              <h1>Novinky a akce</h1>
              <p>
                Prohlédněte si výběr novinek a produkty označené v katalogu jako akční. Zobrazené
                prodejní ceny vycházejí z dodaného feedu.
              </p>
              <PrimaryLinkButton href="#action-products">Zobrazit akční nabídku</PrimaryLinkButton>
            </div>
          </div>
        </header>
        <section className="akros-news-section" aria-labelledby="new-products-title">
          <div className="akros-section__heading">
            <h2 id="new-products-title">Nové nerezové produkty v nabídce</h2>
            <NextLink href="/vyhledavani?q=novinka">Zobrazit všechny novinky</NextLink>
          </div>
          <ProductGrid action="detail" products={newProducts.map(toProductSummary)} />
        </section>
        <section
          className="akros-news-section akros-news-section--sale"
          id="action-products"
          aria-labelledby="sale-products-title"
        >
          <div className="akros-section__heading">
            <h2 id="sale-products-title">Akční nabídky a výprodej</h2>
            <NextLink href="/vyhledavani?q=akce">Zobrazit celou akční nabídku</NextLink>
          </div>
          <ProductGrid products={promotionProducts} />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
