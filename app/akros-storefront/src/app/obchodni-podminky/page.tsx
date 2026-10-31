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
            "Kontaktní formulář předává podnět týmu AKROS jako úkol v OntOS. Podnět k reklamaci není automaticky veden jako reklamační případ. Úplná pravidla pro objednávky, odstoupení a reklamace musí před produkčním provozem dodat provozovatel.",
          ],
        },
      ]}
    />
  );
}
