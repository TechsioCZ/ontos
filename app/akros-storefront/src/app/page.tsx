import Image from "next/image";

import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getHomepageFeaturedProducts } from "@/mock-storefront/catalog";

const benefits = [
  { src: "/akros/home/phone-support.png", alt: "Telefonická podpora AKROS" },
  { src: "/akros/home/branches.png", alt: "Tři pobočky v České republice" },
  { src: "/akros/home/free-shipping.png", alt: "Doprava zdarma od 3 000 Kč bez DPH" },
];

export default function HomePage() {
  return (
    <StorefrontShell>
      <section className="akros-benefits" aria-label="Výhody nákupu">
        {benefits.map((benefit) => (
          <Image
            key={benefit.src}
            alt={benefit.alt}
            height={110}
            loading="eager"
            sizes="(max-width: 760px) 340px, 323px"
            src={benefit.src}
            width={323}
          />
        ))}
      </section>

      <section className="akros-hero" aria-labelledby="partner-title">
        <Image
          alt="Podání rukou symbolizující partnerský program AKROS"
          fetchPriority="high"
          fill
          loading="eager"
          sizes="(max-width: 760px) calc(100vw - 32px), 1000px"
          src="/akros/home/partner-program.png"
        />
        <div className="akros-hero__overlay">
          <h1 id="partner-title">{cs.home.partnerTitle}</h1>
          <PrimaryLinkButton href="/partnersky-program">{cs.actions.enter}</PrimaryLinkButton>
        </div>
      </section>

      <section className="akros-section" aria-labelledby="featured-title">
        <div className="akros-section__heading">
          <h2 id="featured-title">{cs.home.featuredTitle}</h2>
        </div>
        <FeaturedProductGrid products={getHomepageFeaturedProducts()} />
      </section>

      <section className="akros-company-intro" aria-labelledby="company-title">
        <h2 id="company-title">{cs.home.companyTitle}</h2>
        <p>{cs.home.companyDescription}</p>
      </section>
    </StorefrontShell>
  );
}
