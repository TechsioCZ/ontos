import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { HomeCarousel } from "@/components/home-carousel";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

export default function HomePage() {
  return (
    <StorefrontShell>
      <HomeCarousel />

      <section className="akros-section" aria-labelledby="featured-title">
        <div className="akros-section__heading">
          <h2 id="featured-title">{cs.home.featuredTitle}</h2>
        </div>
        <FeaturedProductGrid products={getHomepageFeaturedProducts().map(toProductSummary)} />
      </section>

      <section className="akros-company-intro" aria-labelledby="company-title">
        <h2 id="company-title">{cs.home.companyTitle}</h2>
        <p>{cs.home.companyDescription}</p>
      </section>
    </StorefrontShell>
  );
}
