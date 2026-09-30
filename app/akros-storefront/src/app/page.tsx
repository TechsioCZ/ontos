import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { HomeCarousel } from "@/components/home-carousel";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

export default function HomePage() {
  return (
    <StorefrontShell>
      <HomeCarousel />

      <section className="grid gap-4" aria-labelledby="featured-title">
        <div className="bg-base-dark px-4 py-2 text-base-light">
          <h2 className="m-0 text-base font-bold leading-tight" id="featured-title">
            {cs.home.featuredTitle}
          </h2>
        </div>
        <FeaturedProductGrid products={getHomepageFeaturedProducts().map(toProductSummary)} />
      </section>

      <section
        aria-label={cs.home.companyIntro.label}
        className="mt-20 grid gap-3 px-2 text-sm leading-normal max-md:mt-8"
      >
        {cs.home.companyIntro.paragraphs.map((paragraph) => (
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
