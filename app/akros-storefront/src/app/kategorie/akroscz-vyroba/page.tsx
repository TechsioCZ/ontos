import type { Metadata } from "next";
import StoreLink from "@/components/store-link";

import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "AKROS CZ výroba" };

export default function ManufacturingPage() {
  return (
    <StorefrontShell activeCategorySlug="akroscz-vyroba">
      <StorefrontBreadcrumbs items={[{ href: "/", label: "Domů" }, { label: "AKROS CZ výroba" }]} />
      <article className="akros-content-page">
        <header className="akros-content-page__heading">
          <h1>AKROS CZ výroba</h1>
          <p>
            Zakázková výroba a zpracování materiálu pro průmysl, stavebnictví a technické projekty.
          </p>
        </header>
        <section className="akros-content-panel" aria-labelledby="manufacturing-services-title">
          <h2 id="manufacturing-services-title">Výrobní služby</h2>
          <p>
            AKROS CZ nabízí zakázkovou výrobu, laserové řezání, svařování a tváření plechů. Součástí
            nabídky jsou také galvanické povrchové úpravy pro vybrané materiály.
          </p>
          <ul className="akros-service-list">
            <li>Zakázková výroba</li>
            <li>Laserové řezání</li>
            <li>Svařování</li>
            <li>Tváření plechů</li>
            <li>Galvanické povrchové úpravy</li>
          </ul>
        </section>
        <section className="akros-content-panel" aria-labelledby="manufacturing-contact-title">
          <h2 id="manufacturing-contact-title">Řešení pro váš projekt</h2>
          <p>
            Pro informace o možnostech zpracování materiálu a zakázkové výrobě přejděte na{" "}
            <StoreLink href="/kontakty">kontakty AKROS</StoreLink>.
          </p>
          <p>
            Hledáte hotový materiál? Prohlédněte si{" "}
            <StoreLink href="/kategorie/nerezovy-spojovaci-material">
              nerezový spojovací materiál
            </StoreLink>{" "}
            nebo{" "}
            <StoreLink href="/kategorie/nerezovy-hutni-material">nerezový hutní materiál</StoreLink>
            .
          </p>
        </section>
      </article>
    </StorefrontShell>
  );
}
