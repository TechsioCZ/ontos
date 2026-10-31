import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Partnerský program" };

export default function PartnerPage() {
  return (
    <SimpleContentPage
      title="Partnerský program AKROS"
      lead="Výhody pro pravidelné odběratele a firemní zákazníky."
      sections={[
        {
          title: "Individuální podmínky",
          paragraphs: [
            "Partnerský program v prototypu představuje budoucí přístup k individuálním cenám, historii objednávek a rychlejšímu nákupu.",
          ],
        },
        {
          title: "Jak se zapojit",
          paragraphs: [
            "Pro demonstraci použijte registrační formulář. Registrace se zpracuje pouze lokálně a nic neodesílá.",
          ],
        },
      ]}
    />
  );
}
