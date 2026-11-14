import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { HomeCarousel } from "@/components/home-carousel";
import { StorefrontShell } from "@/components/storefront-shell";
import { brandLocale, getBrand } from "@/brand";
import { getActiveMarket, getDictionary } from "@/ontos/active-market";
import { getCatalog } from "@/ontos/catalog-server";

export default async function HomePage() {
  const [{ getHomepageFeaturedProducts, toProductSummary }, cs, market] = await Promise.all([
    getCatalog(),
    getDictionary(),
    getActiveMarket(),
  ]);
  const brand = getBrand();
  const locale = brandLocale(market.locale);
  const copy = brand.copy[locale];
  const slides = brand.carousel.map(({ alt, ...slide }) => ({ ...slide, alt: alt[locale] }));
  return (
    <StorefrontShell>
      <HomeCarousel slides={slides} title={copy.companyTitle} />

      <section className="grid gap-4" aria-labelledby="featured-title">
        <div className="flex min-h-(--dimension-48) items-center bg-base-dark px-(--dimension-20) py-(--dimension-8) text-base-light">
          <h2 className="m-0 text-md font-bold leading-(--line-height-30)" id="featured-title">
            {cs.home.featuredTitle}
          </h2>
        </div>
        <FeaturedProductGrid products={getHomepageFeaturedProducts().map(toProductSummary)} />
      </section>

      <section
        aria-label={copy.companyIntro.label}
        className="mt-20 grid gap-3 px-2 text-sm leading-normal max-md:mt-8"
      >
        {copy.companyIntro.paragraphs.map((paragraph) => (
          <p className="m-0" key={paragraph.id}>
            {paragraph.content.map((part) =>
              typeof part === "string" ? part : <strong key={part.strong}>{part.strong}</strong>,
            )}
          </p>
        ))}
      </section>
    </StorefrontShell>
  );
}
