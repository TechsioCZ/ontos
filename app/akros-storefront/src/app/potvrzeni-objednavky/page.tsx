import type { Metadata } from "next";
import NextLink from "next/link";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { mockCustomer } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Potvrzení objednávky" };

export default function OrderConfirmationPage() {
  return (
    <StorefrontWideShell>
      <section className="akros-confirmation" aria-labelledby="confirmation-title">
        <span className="akros-confirmation__icon" aria-hidden="true">
          ✓
        </span>
        <header>
          <h1 id="confirmation-title">Děkujeme za vaši objednávku!</h1>
          <p>Vaše objednávka byla úspěšně přijata a systém ji zpracovává.</p>
        </header>
        <div className="akros-confirmation__details">
          <dl>
            <div>
              <dt>Číslo objednávky</dt>
              <dd>#2024-00847</dd>
            </div>
            <div>
              <dt>Předpokládané doručení</dt>
              <dd>Čtvrtek, 12. října 2026</dd>
            </div>
            <div>
              <dt>Způsob doručení</dt>
              <dd>PPL Kurýr (119 Kč)</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Doručovací adresa</dt>
              <dd>
                {mockCustomer.name}, {mockCustomer.company}
                <br />
                {mockCustomer.address}
              </dd>
            </div>
            <div>
              <dt>Způsob platby</dt>
              <dd>Online platební kartou (zaplaceno)</dd>
            </div>
          </dl>
        </div>
        <div className="akros-confirmation__actions">
          <PrimaryLinkButton href="/sledovani-zasilky" uppercase={false}>
            Sledovat zásilku
          </PrimaryLinkButton>
          <NextLink href="/">Zpět na hlavní stránku</NextLink>
        </div>
        <p>
          Na váš e-mail {mockCustomer.email} jsme v této ukázce připravili potvrzení objednávky.
        </p>
      </section>
    </StorefrontWideShell>
  );
}
