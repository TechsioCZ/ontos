// AKROS chrome copy per market language (moved verbatim from src/i18n/{cs,sk,en}.ts).
import "server-only";
import type { BrandCopy, BrandLocale } from "./types";

export const akrosCopy: Readonly<Record<BrandLocale, BrandCopy>> = {
  cs: {
    companyTitle: "AKROS – partner pro hutní a spojovací materiál",
    companyIntro: {
      label: "O společnosti AKROS",
      paragraphs: [
        {
          id: "welcome",
          content: [
            "Vítejte v internetovém obchodě společnosti AKROS - specialistů v oblasti nerezového materiálu. Nabízíme nejširší sortiment kvalitních nerezových spojovacích a hutních materiálů, jaký můžete na našem trhu nalézt. V kategorii ",
            { strong: "nerezových spojovacích materiálů" },
            " najdete např. šrouby, matice, vruty, kolíky, nýty, řetězy, nářadí, maziva nebo příslušenství a doplňky pro jachty. V kategorii ",
            { strong: "nerezový hutní materiál" },
            " můžete nakoupit plechy, trubky, tyče, kolena, příruby, armatury a další příslušenství.",
          ],
        },
        {
          id: "assortment",
          content: [
            "Pravidelně pro Vás budeme ",
            { strong: "rozšiřovat sortiment o nové produkty" },
            ", které naleznete v sekci Nově nabízené zboží. Doporučujeme také sledovat Výprodej a Zboží v akci.",
          ],
        },
        {
          id: "production",
          content: [
            "Zabýváme se rovněž ",
            { strong: "seriovou zámečnickou výrobou i výrobou na zakázku" },
            ". Výroba na zakázku se specializuje také na ",
            { strong: "výrobky z nerezové oceli" },
            ", jako jsou zábradlí nebo ",
            { strong: "schodiště" },
            ".",
          ],
        },
        {
          id: "contact",
          content: [
            "V případě dotazů nebo připomínek nás neváhejte kontaktovat. Věříme, že neustálé vylepšování poskytovaných služeb a rozšiřování sortimentu poskytne našim zákazníkům prostor k pohodlným nákupům.",
          ],
        },
      ],
    },
    copyright: "Copyright (c) 2014–2026 AKROS b2c",
    production: { headerLabel: "AKROS CZ výroba", sidebarLabel: "AKROSCZ Výroba" },
  },
  sk: {
    companyTitle: "AKROS – partner pre hutnícky a spojovací materiál",
    companyIntro: {
      label: "O spoločnosti AKROS",
      paragraphs: [
        {
          id: "welcome",
          content: [
            "Vitajte v internetovom obchode spoločnosti AKROS – špecialistov na nerezový materiál. Ponúkame široký sortiment kvalitných nerezových spojovacích a hutníckych materiálov. V kategórii ",
            { strong: "nerezových spojovacích materiálov" },
            " nájdete napr. skrutky, matice, vruty, kolíky, nity, reťaze, náradie a príslušenstvo. V kategórii ",
            { strong: "nerezový hutnícky materiál" },
            " môžete nakúpiť plechy, rúry, tyče, kolená, príruby a armatúry.",
          ],
        },
        {
          id: "assortment",
          content: [
            "Pravidelne pre vás budeme ",
            { strong: "rozširovať sortiment o nové produkty" },
            ". Odporúčame sledovať aj výpredaj a akciový tovar.",
          ],
        },
        {
          id: "production",
          content: [
            "Zaoberáme sa aj ",
            { strong: "sériovou zámočníckou výrobou a výrobou na zákazku" },
            ", napríklad ",
            { strong: "výrobkami z nerezovej ocele" },
            " ako sú zábradlia alebo ",
            { strong: "schodiská" },
            ".",
          ],
        },
        {
          id: "contact",
          content: [
            "V prípade otázok alebo pripomienok nás neváhajte kontaktovať. Opis produktov je uvedený v češtine.",
          ],
        },
      ],
    },
    copyright: "Copyright (c) 2014–2026 AKROS b2c",
    production: { headerLabel: "AKROS CZ výroba", sidebarLabel: "AKROSCZ Výroba" },
  },
  en: {
    companyTitle: "AKROS – your partner for steel products and fasteners",
    companyIntro: {
      label: "About AKROS",
      paragraphs: [
        {
          id: "welcome",
          content: [
            "Welcome to the online shop of AKROS, specialists in stainless steel. We offer a wide range of quality ",
            { strong: "stainless fasteners" },
            " such as bolts, nuts, screws, pins, rivets, chains and tools, and ",
            { strong: "stainless steel products" },
            " such as sheets, tubes, bars, elbows, flanges and fittings.",
          ],
        },
        {
          id: "assortment",
          content: [
            "We regularly ",
            { strong: "add new products to the range" },
            ". Keep an eye on our clearance and special offers too.",
          ],
        },
        {
          id: "production",
          content: [
            "We also provide ",
            { strong: "batch and custom-made metalwork" },
            ", including ",
            { strong: "stainless steel products" },
            " such as railings and ",
            { strong: "staircases" },
            ".",
          ],
        },
        {
          id: "contact",
          content: [
            "If you have any questions, please contact us. Product descriptions are provided in Czech.",
          ],
        },
      ],
    },
    copyright: "Copyright (c) 2014–2026 AKROS b2c",
    production: { headerLabel: "AKROS CZ manufacturing", sidebarLabel: "AKROSCZ Manufacturing" },
  },
};
