import type { Metadata } from "next";
import { getBrand } from "@/brand";
import Image from "next/image";
import StoreLink from "@/components/store-link";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductGrid } from "@/components/product-grid";
import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { newsCopy } from "@/content/pages";
import { getCatalog, getCatalogPage, type CatalogModel } from "@/ontos/catalog-server";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export async function generateMetadata(): Promise<Metadata> {
  return { title: newsCopy[await contentLocale()].title };
}

const isGenericPromotionGroup = (name: string) => name.trim().toLocaleUpperCase("cs-CZ") === "AKCE";

export default async function NewsPage() {
  const copy = newsCopy[await contentLocale()];
  const baseCatalog = await getCatalog();
  // One flagged owner page (cards) per section; the model below still filters isNew/isAction/isSale locally.
  const flagged = async (flag: "new" | "promotion"): Promise<CatalogModel> => {
    try {
      return (await getCatalogPage({ flag, pageSize: 48 })).model;
    } catch (error) {
      console.error("[AKROS] novinky", flag, isError(error) ? error.message : error);
      return baseCatalog;
    }
  };
  const [{ getNewProducts }, { getPromotionItems }] = await Promise.all([
    flagged("new"),
    flagged("promotion"),
  ]);
  const { toProductSummary } = baseCatalog;
  const promotedItems = getPromotionItems()
    .filter(({ product }) => !isGenericPromotionGroup(product.name))
    .filter(
      ({ product }) => product.priceMinor > 0 && product.stockCount >= product.minimumQuantity,
    )
    .sort((left, right) => Number(right.kind === "sale") - Number(left.kind === "sale"))
    .slice(0, 4);
  const promotedProductIds = new Set(promotedItems.map(({ product }) => product.id));
  const newProducts = getNewProducts()
    .filter(
      (product) => !promotedProductIds.has(product.id) && !isGenericPromotionGroup(product.name),
    )
    .slice(0, 4);
  const promotionProducts = promotedItems.map(({ product }) => toProductSummary(product));

  return (
    <StorefrontWideShell>
      <article className="sf-news-page">
        <header className="sf-news-hero">
          <Image
            alt={copy.heroAlt}
            fill
            loading="eager"
            priority
            sizes="100vw"
            src={getBrand().pages.newsHero}
          />
          <div className="sf-news-hero__overlay">
            <div>
              <Badge size="sm" variant="danger">
                {copy.badge}
              </Badge>
              <h1>{copy.heading}</h1>
              <p>{copy.intro}</p>
              <PrimaryLinkButton href="#action-products">{copy.heroAction}</PrimaryLinkButton>
            </div>
          </div>
        </header>
        <section
          className="sf-news-section sf-product-listing-section"
          aria-labelledby="new-products-title"
        >
          <div className="sf-section__heading">
            <h2 id="new-products-title">{copy.newHeading}</h2>
            <StoreLink href="/vyhledavani?q=novinka">{copy.newAll}</StoreLink>
          </div>
          <ProductGrid action="detail" products={newProducts.map(toProductSummary)} />
        </section>
        <section
          className="sf-news-section sf-news-section--sale sf-product-listing-section"
          id="action-products"
          aria-labelledby="sale-products-title"
        >
          <div className="sf-section__heading">
            <h2 id="sale-products-title">{copy.saleHeading}</h2>
            <StoreLink href="/vyhledavani?q=akce">{copy.saleAll}</StoreLink>
          </div>
          <ProductGrid products={promotionProducts} />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
