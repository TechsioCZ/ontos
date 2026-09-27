import type { Metadata } from "next";
import NextLink from "next/link";

import { AccountShell } from "@/components/account-shell";
import { mockCustomer } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Můj účet" };

export default function AccountPage() {
  return (
    <AccountShell active="overview">
      <div className="akros-account-notice">
        Vaše objednávka <strong>#2024-00847</strong> byla úspěšně expedována. Můžete ji sledovat v
        reálném čase.
      </div>
      <section className="akros-account-welcome">
        <h1>Dobrý den, {mockCustomer.name}</h1>
        <p>
          Vítejte ve svém zákaznickém panelu. Zde naleznete přehled o objednávkách a nastavení účtu.
        </p>
      </section>
      <section className="akros-account-metrics" aria-label="Přehled účtu">
        <article>
          <span>Objednávky celkem</span>
          <strong>24</strong>
          <small>Naposledy nakoupeno včera</small>
        </article>
        <article>
          <span>Věrnostní body</span>
          <strong>1 250 b.</strong>
          <small>Sleva 5 % na příští nákup</small>
        </article>
        <article>
          <span>Poslední objednávka</span>
          <strong>#2024-00847</strong>
          <small>Odesláno</small>
        </article>
      </section>
      <section className="akros-account-quick-links">
        <article>
          <h2>Historie objednávek</h2>
          <p>Prohlédněte si všechny své minulé nákupy, faktury a dodací listy.</p>
          <NextLink href="/historie-objednavek">Zobrazit objednávky</NextLink>
        </article>
        <article>
          <h2>Oblíbené položky</h2>
          <p>Rychlý přístup ke zboží, které pravidelně nakupujete a odebíráte.</p>
          <NextLink href="/oblibene">Otevřít seznam</NextLink>
        </article>
      </section>
    </AccountShell>
  );
}
