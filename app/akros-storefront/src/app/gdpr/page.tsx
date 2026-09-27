import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Ochrana osobních údajů" };

export default function PrivacyPage() {
  return (
    <SimpleContentPage
      title="Ochrana osobních údajů"
      lead="Prototyp pracuje pouze s lokálními mock daty."
      sections={[
        {
          title: "Jaká data zpracováváme",
          paragraphs: [
            "Formuláře v této ukázce neposílají data na server a nevytvářejí zákaznický účet. Košík se ukládá pouze lokálně v prohlížeči.",
          ],
        },
        {
          title: "Produkční řešení",
          paragraphs: [
            "Zásady a souhlasy budou navázány na skutečné služby až společně s reálným backendem a právním textem provozovatele.",
          ],
        },
      ]}
    />
  );
}
