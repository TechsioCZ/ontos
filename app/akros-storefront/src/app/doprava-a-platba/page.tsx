import type { Metadata } from "next";
import Image from "next/image";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { StorefrontWideShell } from "@/components/storefront-shell";
import { paymentMethods, shippingMethods } from "@/mock-storefront/fixtures/content";

export const metadata: Metadata = { title: "Doprava a platba" };

export default function ShippingPage() {
  return (
    <StorefrontWideShell>
      <article className="akros-landing-page">
        <header className="akros-content-hero">
          <Image
            alt="Balení zásilky nerezového materiálu"
            fill
            loading="eager"
            priority
            sizes="100vw"
            src="/akros/content/shipping-hero.png"
          />
          <div className="akros-content-hero__overlay">
            <Badge size="sm" variant="primary">
              RYCHLÉ DORUČENÍ
            </Badge>
            <h1>Informace o dopravě a možnostech platby</h1>
            <p>
              Záleží nám na tom, aby k vám nerezový materiál dorazil co nejrychleji a bezpečně.
              Vyberte si ze spolehlivých dopravců a pohodlných metod placení.
            </p>
          </div>
        </header>

        <div className="akros-shipping-layout">
          <section aria-labelledby="shipping-methods-title">
            <h2 id="shipping-methods-title">Způsoby dopravy</h2>
            <div className="akros-option-list">
              {shippingMethods.map((method) => (
                <article key={method.title}>
                  <div className="akros-option-list__heading">
                    <h3>{method.title}</h3>
                    <strong>{method.price}</strong>
                  </div>
                  <p className="akros-option-list__status">Doručení: {method.delivery}</p>
                  <p>{method.description}</p>
                </article>
              ))}
            </div>
          </section>
          <section aria-labelledby="payment-methods-title">
            <h2 id="payment-methods-title">Způsoby platby</h2>
            <div className="akros-option-list akros-option-list--compact">
              {paymentMethods.map((method) => (
                <article key={method.title}>
                  <h3>{method.title}</h3>
                  <p>{method.description}</p>
                </article>
              ))}
            </div>
            <aside className="akros-free-shipping" aria-label="Doprava zdarma">
              <div>
                <strong>Doprava zdarma nad 2 000 Kč</strong>
                <span>Zbývá 580 Kč</span>
              </div>
              <progress max="2000" value="1420">
                1 420 Kč z 2 000 Kč
              </progress>
              <p>V ukázkovém košíku máte zboží za 1 420 Kč. Nakupte ještě za 580 Kč.</p>
            </aside>
          </section>
        </div>
      </article>
    </StorefrontWideShell>
  );
}
