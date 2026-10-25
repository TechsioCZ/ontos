import type { Metadata } from "next";
import Image from "next/image";
import StoreLink from "@/components/store-link";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductGrid } from "@/components/product-grid";
import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { getCatalog, getCatalogPage, type CatalogModel } from "@/ontos/catalog-server";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export const metadata: Metadata = { title: "Novinky a akce" };

const isGenericPromotionGroup = (name: string) => name.trim().toLocaleUpperCase("cs-CZ") === "AKCE";

export default async function NewsPage() {
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
                prodejní ceny vycházejí z katalogu OntOS.
              </p>
              <PrimaryLinkButton href="#action-products">Zobrazit akční nabídku</PrimaryLinkButton>
            </div>
          </div>
        </header>
        <section
          className="akros-news-section akros-product-listing-section"
          aria-labelledby="new-products-title"
        >
          <div className="akros-section__heading">
            <h2 id="new-products-title">Nové nerezové produkty v nabídce</h2>
            <StoreLink href="/vyhledavani?q=novinka">Zobrazit všechny novinky</StoreLink>
          </div>
          <ProductGrid action="detail" products={newProducts.map(toProductSummary)} />
        </section>
        <section
          className="akros-news-section akros-news-section--sale akros-product-listing-section"
          id="action-products"
          aria-labelledby="sale-products-title"
        >
          <div className="akros-section__heading">
            <h2 id="sale-products-title">Akční nabídky a výprodej</h2>
            <StoreLink href="/vyhledavani?q=akce">Zobrazit celou akční nabídku</StoreLink>
          </div>
          <ProductGrid products={promotionProducts} />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
