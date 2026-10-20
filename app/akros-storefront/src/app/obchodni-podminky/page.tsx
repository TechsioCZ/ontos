import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Obchodní podmínky" };

export default function TermsPage() {
  return (
    <SimpleContentPage
      title="Obchodní podmínky"
      lead="Zkrácené informace pro demonstrační storefront AKROS."
      sections={[
        {
          title: "Objednávka a cena",
          paragraphs: [
            "Tento prototyp nevytváří skutečné objednávky ani platební závazky. Uvedené ceny a dostupnost slouží pouze k prezentaci uživatelského rozhraní.",
          ],
        },
        {
          title: "Odstoupení a reklamace",
          paragraphs: [
            "Ukázkový formulář a kontaktní údaje nic neodesílají. Produkční pravidla budou doplněna až při napojení reálného backendu.",
          ],
        },
      ]}
    />
  );
}
