import type { Metadata } from "next";

import { ContentGallery } from "@/components/content-gallery";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { aboutGallery, manufacturingGallery } from "@/mock-storefront/fixtures/content";

export const metadata: Metadata = { title: "O nás" };

export default function AboutPage() {
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs items={[{ href: "/", label: "Domů" }, { label: "O nás" }]} />
      <article className="akros-content-page">
        <header className="akros-content-page__heading">
          <h1>O nás</h1>
          <p>
            AKROS je předním dodavatelem nerezového, hutního a spojovacího materiálu pro průmyslové
            aplikace. Naším cílem je kvalitní sortiment, profesionální poradenství a rychlé dodání
            ze skladů v Praze, Ostravě a Údlicích.
          </p>
        </header>

        <section className="akros-content-panel" aria-labelledby="company-history-title">
          <h2 id="company-history-title">AKROS, s.r.o.</h2>
          <p>
            Společnost AKROS, s.r.o. se specializuje na dodávky nerezového materiálu, hutního
            materiálu a spojovacího materiálu. Nabízíme standardní sortiment i zakázkovou výrobu pro
            průmysl, stavebnictví a technické projekty.
          </p>
          <p>
            Od roku 1994 rozvíjíme sklady, výrobu a odborné poradenství tak, aby zákazníci dostali
            správný materiál ve správné kvalitě a bez zbytečného čekání.
          </p>
        </section>

        <section className="akros-content-section" aria-labelledby="certification-title">
          <h2 id="certification-title">Certifikace</h2>
          <p>Certifikát systému jakosti ISO 9001:2016</p>
          <ContentGallery items={aboutGallery} />
        </section>

        <section className="akros-content-panel">
          <p>
            Společnost AKROS CZ, s.r.o. disponuje vlastními výrobními kapacitami pro zakázkovou
            výrobu, laserové řezání, svařování a tváření plechů. Moderní technologické zázemí
            zajišťuje vysokou kvalitu finálních produktů.
          </p>
        </section>

        <section className="akros-content-section" aria-labelledby="services-title">
          <h2 id="services-title">Výrobní služby</h2>
          <ul className="akros-service-list">
            <li>Zakázková výroba</li>
            <li>Laserové řezání</li>
            <li>Svařování</li>
            <li>Tváření plechů</li>
          </ul>
        </section>

        <section className="akros-content-section" aria-labelledby="finishing-title">
          <div className="akros-content-panel">
            <h2 id="finishing-title">Galvanické povrchové úpravy</h2>
            <p>Nabízíme také galvanické povrchové úpravy pro vybrané materiály.</p>
          </div>
          <ContentGallery items={manufacturingGallery} />
        </section>
      </article>
    </StorefrontShell>
  );
}
