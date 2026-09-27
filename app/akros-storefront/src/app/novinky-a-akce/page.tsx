import type { Metadata } from "next";
import Image from "next/image";
import NextLink from "next/link";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { formatPrice } from "@/lib/format";
import { getFeaturedProducts } from "@/mock-storefront/catalog";

export const metadata: Metadata = { title: "Novinky a akce" };

export default function NewsPage() {
  const products = getFeaturedProducts();

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
                BLESKOVÁ AKCE V TÝDNU
              </Badge>
              <h1>15% sleva na veškeré imbusové šrouby DIN 912</h1>
              <p>
                Využijte výjimečné slevy na stavební a průmyslové nerezové šrouby s vnitřním
                šestihranem. Akce platí pro třídy A2 i A4 do vyprodání zásob.
              </p>
              <PrimaryLinkButton href="/kategorie/srouby">Nakoupit v akci</PrimaryLinkButton>
            </div>
            <aside className="akros-countdown" aria-label="Časově omezená nabídka">
              <strong>ČASOVĚ OMEZENÁ NABÍDKA</strong>
              <div>
                <span>
                  <b>02</b>DNY
                </span>
                <span>
                  <b>14</b>HOD
                </span>
                <span>
                  <b>35</b>MIN
                </span>
              </div>
              <p>Akce bude ukončena v neděli o půlnoci</p>
            </aside>
          </div>
        </header>
        <section className="akros-news-section" aria-labelledby="new-products-title">
          <div className="akros-section__heading">
            <h2 id="new-products-title">Nové nerezové produkty v nabídce</h2>
            <NextLink href="/vyhledavani?q=nerez">Zobrazit všechny novinky</NextLink>
          </div>
          <div className="akros-news-grid">
            {products.map((product) => (
              <article key={product.id}>
                <Image
                  alt={product.imageAlt}
                  height={360}
                  loading="lazy"
                  src={product.imageSrc}
                  width={480}
                />
                <Badge size="sm" variant="primary">
                  NOVINKA
                </Badge>
                <h3>{product.name}</h3>
                <strong>od {formatPrice(product.priceMinor)}</strong>
                <PrimaryLinkButton href={`/produkt/${product.slug}`} size="sm" uppercase={false}>
                  Detail
                </PrimaryLinkButton>
              </article>
            ))}
          </div>
        </section>
        <section className="akros-news-section" aria-labelledby="sale-products-title">
          <div className="akros-section__heading">
            <h2 id="sale-products-title">Akční nabídky a výprodej</h2>
            <NextLink href="/vyhledavani?q=akce">Zobrazit celou akční nabídku</NextLink>
          </div>
          <div className="akros-news-grid">
            {products.toReversed().map((product, index) => (
              <article key={product.id}>
                <Image
                  alt={product.imageAlt}
                  height={360}
                  loading="lazy"
                  src={product.imageSrc}
                  width={480}
                />
                <span className="akros-discount">−{15 + index * 4}%</span>
                <h3>{product.name}</h3>
                <strong>{formatPrice(Math.round(product.priceMinor * 0.8))}</strong>
                <PrimaryLinkButton href={`/produkt/${product.slug}`} size="sm" uppercase={false}>
                  Do košíku
                </PrimaryLinkButton>
              </article>
            ))}
          </div>
        </section>
      </article>
    </StorefrontWideShell>
  );
}
