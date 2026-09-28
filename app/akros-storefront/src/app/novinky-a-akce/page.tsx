import type { Metadata } from "next";
import Image from "next/image";
import NextLink from "next/link";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { NewsProductGrid, type NewsProductCardItem } from "@/components/news-product-grid";
import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getNewProducts, getPromotionItems } from "@/mock-storefront/catalog";

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
  const newItems: NewsProductCardItem[] = newProducts.map((product) => ({
    id: product.id,
    productId: product.id,
    slug: product.slug,
    name: product.name,
    productName: product.name,
    sku: product.sku,
    imageSrc: product.imageSrc,
    imageAlt: product.imageAlt,
    priceMinor: product.priceMinor,
    currency: product.currency,
    unit: product.unit,
    stockCount: product.stockCount,
    minimumQuantity: product.minimumQuantity,
    kind: "new",
  }));
  const promotionItems: NewsProductCardItem[] = promotedItems.map(({ product, variant, kind }) => ({
    id: `${product.id}-${variant?.id ?? "product"}`,
    productId: product.id,
    variantId: variant?.id,
    slug: product.slug,
    name: variant?.label ?? product.name,
    productName: product.name,
    sku: variant?.sku ?? product.sku,
    imageSrc: variant?.imageSrc ?? product.imageSrc,
    imageAlt: variant?.label ?? product.imageAlt,
    priceMinor: variant?.priceMinor ?? product.priceMinor,
    originalPriceMinor: variant?.originalPriceMinor ?? product.originalPriceMinor,
    currency: product.currency,
    unit: variant?.unit ?? product.unit,
    stockCount: variant?.stockCount ?? product.stockCount,
    minimumQuantity: variant?.minimumQuantity ?? product.minimumQuantity,
    variantLabel: variant?.label,
    kind,
  }));

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
          <NewsProductGrid items={newItems} />
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
          <NewsProductGrid items={promotionItems} />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
