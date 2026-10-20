import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Obchodní podmínky" };

export default function TermsPage() {
  return (
    <SimpleContentPage
      title="Obchodní podmínky"
      lead="Zkrácené informace pro prezentační e-shop AKROS."
      sections={[
        {
          title: "Objednávka a cena",
          paragraphs: [
            "DEMO objednávka se uloží do odděleného prezentačního prostředí. Nevzniká platební závazek, nic neplatíte a zboží nebude odesláno ani doručeno. Ceny a dostupnost přebíráme z OntOS.",
          ],
        },
        {
          title: "Odstoupení a reklamace",
          paragraphs: [
            "Ukázkový formulář nic neodesílá. Úplná pravidla pro skutečné objednávky, odstoupení a reklamace budou doplněna při napojení na skutečný objednávkový systém.",
          ],
        },
      ]}
    />
  );
}
