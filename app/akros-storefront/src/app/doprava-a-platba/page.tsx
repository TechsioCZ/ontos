import type { Metadata } from "next";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { shippingCopy } from "@/content/pages";
import { readCheckoutOptions } from "@/ontos/checkout-options";
import { formatPrice } from "@/lib/format";
import { getMoney } from "@/ontos/active-market";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: shippingCopy[await contentLocale()].metadataTitle };
}
export default async function ShippingPage() {
  const [locale, options, money] = await Promise.all([
    contentLocale(),
    readCheckoutOptions(),
    getMoney(),
  ]);
  const copy = shippingCopy[locale];
  return (
    <StorefrontWideShell>
      <article className="sf-landing-page py-8">
        <h1>{copy.title}</h1>
        <div className="sf-shipping-layout">
          <section aria-labelledby="shipping-methods-title">
            <h2 id="shipping-methods-title">{copy.methodsHeading}</h2>
            <div className="sf-option-list">
              {options.shippingMethods.map((method) => (
                <article key={method.id}>
                  <div className="sf-option-list__heading">
                    <h3>{method.title}</h3>
                    <strong>{formatPrice(method.priceMinor, money)}</strong>
                  </div>
                  <p>{copy.methodNote}</p>
                </article>
              ))}
            </div>
            {!options.shippingMethods.length && <p>{copy.noMethods}</p>}
          </section>
          <section aria-labelledby="payment-methods-title">
            <h2 id="payment-methods-title">{copy.paymentHeading}</h2>
            <p>{copy.paymentText}</p>
          </section>
        </div>
      </article>
    </StorefrontWideShell>
  );
}
