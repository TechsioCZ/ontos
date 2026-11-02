import type { Metadata } from "next";
import { getBrand } from "@/brand";
import { ContactForm } from "@/components/contact-form";
import { StorefrontShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "Reklamace" };
export default function ClaimsPage() {
  return (
    <StorefrontShell>
      <article className="sf-content-page">
        <h1>Reklamace</h1>
        <p>
          Popište problém a uveďte číslo objednávky a kód produktu. Podnět uložíme jako úkol pro
          podporu {getBrand().name} v OntOS. Nejde o automatické založení reklamačního případu;
          další postup s vámi dohodne pracovník podpory.
        </p>
        <ContactForm kind="COMPLAINT" />
      </article>
    </StorefrontShell>
  );
}
