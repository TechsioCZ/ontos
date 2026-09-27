import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import {
  getCategoryById,
  getCategoryTrail,
  getFeaturedProducts,
  getProductBySlug,
} from "@/mock-storefront/catalog";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = getProductBySlug(slug);

  return { title: product?.name ?? "Produkt" };
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const recommendations = getFeaturedProducts()
    .filter((candidate) => candidate.id !== product.id)
    .slice(0, 4);

  return (
    <StorefrontShell activeCategorySlug={category?.slug}>
      <StorefrontBreadcrumbs
        items={[
          { href: "/", label: cs.header.home },
          ...categoryTrail.map((item) => ({
            href: `/kategorie/${item.slug}`,
            label: item.name,
          })),
          { label: product.name },
        ]}
      />

      <article className="akros-product-detail">
        <header className="akros-product-detail__heading">
          <p>
            {cs.product.sku}: {product.sku}
          </p>
          <h1>{product.name}</h1>
        </header>

        <div className="akros-product-detail__lead">
          <div className="akros-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              height={620}
              loading="eager"
              priority
              sizes="(max-width: 760px) 100vw, 42vw"
              src={product.imageSrc}
              style={{ height: "auto" }}
              width={620}
            />
            {product.secondaryImageSrc && (
              <Image
                alt={`Technický nákres: ${product.name}`}
                height={180}
                loading="lazy"
                src={product.secondaryImageSrc}
                style={{ height: "auto" }}
                width={620}
              />
            )}
          </div>

          <aside className="akros-product-detail__order" aria-label={cs.product.productActions}>
            <p className="akros-product-detail__stock">
              {cs.product.inStock}:{" "}
              <strong>
                {product.stockCount.toLocaleString("cs-CZ")} {product.unit}
              </strong>
            </p>
            <p className="akros-product-detail__price">
              {formatPrice(product.priceMinor, product.currency)} <span>/ {product.unit}</span>
            </p>
            <p>{product.description}</p>
            <ProductPurchaseForm productId={product.id} />
          </aside>
        </div>

        <section className="akros-product-detail__section" aria-labelledby="quantity-pricing-title">
          <h2 id="quantity-pricing-title">{cs.product.quantityPricing}</h2>
          <p>Ceny jsou uvedeny za jeden kus. Sleva se přepočítá podle zvoleného množství.</p>
          <dl className="akros-price-tiers">
            <div>
              <dt>1–99 {product.unit}</dt>
              <dd>{formatPrice(product.priceMinor)}</dd>
            </div>
            <div>
              <dt>100–499 {product.unit}</dt>
              <dd>{formatPrice(Math.round(product.priceMinor * 0.96))}</dd>
            </div>
            <div>
              <dt>500–999 {product.unit}</dt>
              <dd>{formatPrice(Math.round(product.priceMinor * 0.92))}</dd>
            </div>
            <div>
              <dt>1 000 a více</dt>
              <dd>{formatPrice(Math.round(product.priceMinor * 0.88))}</dd>
            </div>
          </dl>
        </section>

        <section className="akros-product-detail__section" aria-labelledby="description-title">
          <h2 id="description-title">{cs.product.details}</h2>
          <p>{product.description}</p>
        </section>
      </article>

      {recommendations.length > 0 && (
        <section className="akros-section" aria-labelledby="product-recommendations-title">
          <h2 id="product-recommendations-title">{cs.catalog.recommendations}</h2>
          <ProductGrid products={recommendations} />
        </section>
      )}
    </StorefrontShell>
  );
}
