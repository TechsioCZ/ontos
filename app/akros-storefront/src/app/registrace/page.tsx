import type { Metadata } from "next";
import NextLink from "next/link";

import { MockRegistrationForm } from "@/components/mock-auth-form";
import { StorefrontWideShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "Registrace" };

const benefits = [
  [
    "Historie a správa objednávek",
    "Mějte přehled o všech fakturách, dodacích listech a stavu doručení.",
  ],
  [
    "Rychlejší příští nákup",
    "Uložené fakturační a dodací adresy pro bleskové dokončení objednávek.",
  ],
  ["Individuální slevové akce", "Speciální partnerské ceny pro stálé odběratele a stavební firmy."],
  ["Seznam přání", "Uložte si často objednávané položky nerezového materiálu na později."],
] as const;

export default function RegistrationPage() {
  return (
    <StorefrontWideShell>
      <section className="akros-registration-page">
        <div className="akros-registration-card">
          <header>
            <h1>Registrace nového zákazníka</h1>
            <p>
              Vytvořte si profesionální účet a získejte okamžitý přístup k velkoobchodním výhodám.
            </p>
          </header>
          <MockRegistrationForm />
          <p>
            Již jste registrováni? <NextLink href="/prihlaseni">Přihlaste se zde</NextLink>
          </p>
        </div>
        <aside className="akros-benefit-card">
          <h2>Velkoobchodní výhody</h2>
          <ul>
            {benefits.map(([title, text]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </aside>
      </section>
    </StorefrontWideShell>
  );
}
