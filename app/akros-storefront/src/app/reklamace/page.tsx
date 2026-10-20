import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Reklamace" };

export default function ClaimsPage() {
  return (
    <SimpleContentPage
      title="Reklamace"
      lead="Přehled ukázkového procesu reklamace."
      sections={[
        {
          title: "Připravte podklady",
          paragraphs: [
            "Poznamenejte si číslo objednávky, kód produktu a stručný popis závady nebo nesrovnalosti.",
          ],
        },
        {
          title: "Kontaktujte podporu",
          paragraphs: [
            "V prototypu můžete použít kontaktní formulář. Zpráva zůstane pouze v lokálním uživatelském rozhraní.",
          ],
        },
      ]}
    />
  );
}
