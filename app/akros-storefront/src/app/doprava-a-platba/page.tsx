import type { Metadata } from "next";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { readCheckoutOptions } from "@/ontos/checkout-options";
import { formatPrice } from "@/lib/format";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Doprava a platba" };
export default async function ShippingPage() {
  const options = await readCheckoutOptions();
  return (
    <StorefrontWideShell>
      <article className="akros-landing-page py-8">
        <h1>Informace o dopravě a možnostech platby</h1>
        <div className="akros-shipping-layout">
          <section aria-labelledby="shipping-methods-title">
            <h2 id="shipping-methods-title">Způsoby dopravy</h2>
            <div className="akros-option-list">
              {options.shippingMethods.map((method) => (
                <article key={method.id}>
                  <div className="akros-option-list__heading">
                    <h3>{method.title}</h3>
                    <strong>{formatPrice(method.priceMinor)}</strong>
                  </div>
                  <p>
                    Aktuální ceník OntOS. Termín doručení ani rezervace dopravce nejsou dostupné.
                  </p>
                </article>
              ))}
            </div>
            {!options.shippingMethods.length && <p>Žádný způsob dopravy není dostupný.</p>}
          </section>
          <section aria-labelledby="payment-methods-title">
            <h2 id="payment-methods-title">Platba</h2>
            <p>
              Objednávku předáme obchodu k vyřízení. Její stav najdete ve svém účtu. E-shop nyní
              nenabízí online platbu; odesláním objednávky neprovádíte úhradu.
            </p>
          </section>
        </div>
      </article>
    </StorefrontWideShell>
  );
}
