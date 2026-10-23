import type { Metadata } from "next";
import { SimpleContentPage } from "@/components/simple-content-page";

export const metadata: Metadata = { title: "Ochrana osobních údajů" };

export default function PrivacyPage() {
  return (
    <SimpleContentPage
      title="Ochrana osobních údajů"
      lead="Informace o zpracování údajů v prezentačním prostředí AKROS."
      sections={[
        {
          title: "Jaká data zpracováváme",
          paragraphs: [
            "Kontaktní formulář odesílá jméno, e-mail a zprávu do OntOS, kde vzniká úkol pro tým AKROS. Podněty k reklamaci a dotazy na produkty zpracovává stejný tým. Oznámení o dotazu se zpracovává prostřednictvím e-mailové služby platformy. Košíky se ukládají v prohlížeči.",
          ],
        },
        {
          title: "Marketing a další informace",
          paragraphs: [
            "Odeslání dotazu není souhlas s marketingem a nepřihlašuje vás k newsletteru. Úplné právní informace včetně dob uchování a uplatnění práv musí dodat provozovatel před produkčním provozem. Do prezentačního prostředí nevkládejte citlivé údaje.",
          ],
        },
      ]}
    />
  );
}
