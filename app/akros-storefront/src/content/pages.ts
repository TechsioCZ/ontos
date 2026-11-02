// Editorial page copy per brand language (`cs`, `sk`, `en`). Functions take the brand name where the text names the shop.
import type { PerLocale } from "@/brand/types";

export interface TextPage {
  title: string;
  lead: string;
  sections: readonly { title: string; paragraphs: readonly string[] }[];
}

/** Obchodní podmínky (terms) page. */
export const termsPage: PerLocale<(name: string) => TextPage> = {
  cs: (name) => ({
    title: "Obchodní podmínky",
    lead: `Zkrácené informace pro prezentační e-shop ${name}.`,
    sections: [
      {
        title: "Objednávka a cena",
        paragraphs: [
          "DEMO objednávka se uloží do odděleného prezentačního prostředí. Nevzniká platební závazek, nic neplatíte a zboží nebude odesláno ani doručeno. Ceny a dostupnost přebíráme z OntOS.",
        ],
      },
      {
        title: "Odstoupení a reklamace",
        paragraphs: [
          `Kontaktní formulář předává podnět týmu ${name} jako úkol v OntOS. Podnět k reklamaci není automaticky veden jako reklamační případ. Úplná pravidla pro objednávky, odstoupení a reklamace musí před produkčním provozem dodat provozovatel.`,
        ],
      },
    ],
  }),
  sk: (name) => ({
    title: "Obchodné podmienky",
    lead: `Skrátené informácie pre prezentačný e-shop ${name}.`,
    sections: [
      {
        title: "Objednávka a cena",
        paragraphs: [
          "DEMO objednávka sa uloží do oddeleného prezentačného prostredia. Nevzniká platobný záväzok, nič neplatíte a tovar nebude odoslaný ani doručený. Ceny a dostupnosť preberáme z OntOS.",
        ],
      },
      {
        title: "Odstúpenie a reklamácie",
        paragraphs: [
          `Kontaktný formulár odovzdáva podnet tímu ${name} ako úlohu v OntOS. Podnet na reklamáciu sa automaticky nevedie ako reklamačný prípad. Úplné pravidlá pre objednávky, odstúpenie od zmluvy a reklamácie musí pred produkčnou prevádzkou dodať prevádzkovateľ.`,
        ],
      },
    ],
  }),
  en: (name) => ({
    title: "Terms and conditions",
    lead: `Summary terms for the ${name} presentation shop.`,
    sections: [
      {
        title: "Order and price",
        paragraphs: [
          "A DEMO order is saved in a separate presentation environment. No payment obligation arises, you pay nothing, and no goods are shipped or delivered. Prices and availability come from OntOS.",
        ],
      },
      {
        title: "Withdrawal and complaints",
        paragraphs: [
          `The contact form passes your request to the ${name} team as a task in OntOS. A complaint is not automatically opened as a claim case. The operator must supply the full rules for orders, withdrawal and complaints before production use.`,
        ],
      },
    ],
  }),
};

/** Ochrana osobních údajů (GDPR) page. */
export const privacyPage: PerLocale<(name: string) => TextPage> = {
  cs: (name) => ({
    title: "Ochrana osobních údajů",
    lead: `Informace o zpracování údajů v prezentačním prostředí ${name}.`,
    sections: [
      {
        title: "Jaká data zpracováváme",
        paragraphs: [
          `Kontaktní formulář odesílá jméno, e-mail a zprávu do OntOS, kde vzniká úkol pro tým ${name}. Podněty k reklamaci a dotazy na produkty zpracovává stejný tým. Oznámení o dotazu se zpracovává prostřednictvím e-mailové služby platformy. Košíky se ukládají v prohlížeči.`,
        ],
      },
      {
        title: "Marketing a další informace",
        paragraphs: [
          "Odeslání dotazu není souhlas s marketingem a nepřihlašuje vás k newsletteru. Úplné právní informace včetně dob uchování a uplatnění práv musí dodat provozovatel před produkčním provozem. Do prezentačního prostředí nevkládejte citlivé údaje.",
        ],
      },
    ],
  }),
  sk: (name) => ({
    title: "Ochrana osobných údajov",
    lead: `Informácie o spracúvaní údajov v prezentačnom prostredí ${name}.`,
    sections: [
      {
        title: "Aké údaje spracúvame",
        paragraphs: [
          `Kontaktný formulár odosiela meno, e-mail a správu do OntOS, kde vzniká úloha pre tím ${name}. Podnety na reklamáciu a otázky k produktom spracúva rovnaký tím. Oznámenie o otázke sa spracúva prostredníctvom e-mailovej služby platformy. Košíky sa ukladajú v prehliadači.`,
        ],
      },
      {
        title: "Marketing a ďalšie informácie",
        paragraphs: [
          "Odoslanie otázky nie je súhlasom s marketingom a neprihlasuje vás do newslettera. Úplné právne informácie vrátane dôb uchovávania a uplatnenia práv musí doplniť prevádzkovateľ pred produkčnou prevádzkou. Do prezentačného prostredia nevkladajte citlivé údaje.",
        ],
      },
    ],
  }),
  en: (name) => ({
    title: "Privacy policy",
    lead: `Information on how data is processed in the ${name} presentation environment.`,
    sections: [
      {
        title: "What data we process",
        paragraphs: [
          `The contact form sends your name, e-mail and message to OntOS, where a task for the ${name} team is created. Complaints and product questions are handled by the same team. The notification about your enquiry is processed through the platform's e-mail service. Carts are stored in your browser.`,
        ],
      },
      {
        title: "Marketing and other information",
        paragraphs: [
          "Sending an enquiry is not consent to marketing and does not subscribe you to our newsletter. The operator must provide the full legal information, including retention periods and how to exercise your rights, before production use. Do not enter sensitive data into this presentation environment.",
        ],
      },
    ],
  }),
};

/** Partnerský program page. */
export const partnerPage: PerLocale<(name: string) => TextPage> = {
  cs: (name) => ({
    title: `Partnerský program ${name}`,
    lead: "Výhody pro pravidelné odběratele a firemní zákazníky.",
    sections: [
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
    ],
  }),
  sk: (name) => ({
    title: `Partnerský program ${name}`,
    lead: "Výhody pre pravidelných odberateľov a firemných zákazníkov.",
    sections: [
      {
        title: "Individuálne podmienky",
        paragraphs: [
          "Partnerský program v prototype predstavuje budúci prístup k individuálnym cenám, histórii objednávok a rýchlejšiemu nákupu.",
        ],
      },
      {
        title: "Ako sa zapojiť",
        paragraphs: [
          "Na ukážku použite registračný formulár. Registrácia sa spracuje iba lokálne a nič sa neodosiela.",
        ],
      },
    ],
  }),
  en: (name) => ({
    title: `${name} partner programme`,
    lead: "Benefits for regular customers and business accounts.",
    sections: [
      {
        title: "Individual terms",
        paragraphs: [
          "In this prototype, the partner programme shows a future approach to individual prices, order history and faster ordering.",
        ],
      },
      {
        title: "How to join",
        paragraphs: [
          "To try it, use the registration form. Registration is processed locally only and nothing is sent.",
        ],
      },
    ],
  }),
};

/** Reklamace (complaints) page: heading and intro, the form follows. */
export const claimsCopy: PerLocale<{ title: string; intro: (name: string) => string }> = {
  cs: {
    title: "Reklamace",
    intro: (name) =>
      `Popište problém a uveďte číslo objednávky a kód produktu. Podnět uložíme jako úkol pro podporu ${name} v OntOS. Nejde o automatické založení reklamačního případu; další postup s vámi dohodne pracovník podpory.`,
  },
  sk: {
    title: "Reklamácie",
    intro: (name) =>
      `Opíšte problém a uveďte číslo objednávky a kód produktu. Podnet uložíme ako úlohu pre podporu ${name} v OntOS. Nie je to automatické založenie reklamačného prípadu; ďalší postup s vami dohodne pracovník podpory.`,
  },
  en: {
    title: "Complaints",
    intro: (name) =>
      `Describe the problem and give your order number and product code. We save your request as a task for the ${name} support team in OntOS. This does not open a complaint case automatically; a support agent will agree the next steps with you.`,
  },
};

/** Doprava a platba (delivery and payment) page. */
export const shippingCopy: PerLocale<{
  title: string;
  metadataTitle: string;
  methodsHeading: string;
  methodNote: string;
  noMethods: string;
  paymentHeading: string;
  paymentText: string;
}> = {
  cs: {
    title: "Informace o dopravě a možnostech platby",
    metadataTitle: "Doprava a platba",
    methodsHeading: "Způsoby dopravy",
    methodNote: "Aktuální ceník OntOS. Termín doručení ani rezervace dopravce nejsou dostupné.",
    noMethods: "Žádný způsob dopravy není dostupný.",
    paymentHeading: "Platba",
    paymentText:
      "Objednávku předáme obchodu k vyřízení. Její stav najdete ve svém účtu. E-shop nyní nenabízí online platbu; odesláním objednávky neprovádíte úhradu.",
  },
  sk: {
    title: "Informácie o doprave a možnostiach platby",
    metadataTitle: "Doprava a platba",
    methodsHeading: "Spôsoby dopravy",
    methodNote:
      "Aktuálny cenník z OntOS. Termín doručenia ani rezervácia prepravcu nie sú dostupné.",
    noMethods: "Žiadny spôsob dopravy nie je dostupný.",
    paymentHeading: "Platba",
    paymentText:
      "Objednávku odovzdáme obchodu na vybavenie. Jej stav nájdete vo svojom účte. E-shop momentálne neponúka online platbu; odoslaním objednávky neuskutočňujete úhradu.",
  },
  en: {
    title: "Delivery and payment information",
    metadataTitle: "Delivery and payment",
    methodsHeading: "Delivery methods",
    methodNote:
      "Current price list from OntOS. Delivery dates and carrier bookings are not available.",
    noMethods: "No delivery method is available.",
    paymentHeading: "Payment",
    paymentText:
      "We pass your order to the shop for processing. You can see its status in your account. The online shop does not offer online payment at the moment; sending an order does not make a payment.",
  },
};

/** Novinky a akce (news and offers) page chrome; the products come from OntOS. */
export const newsCopy: PerLocale<{
  title: string;
  heroAlt: string;
  badge: string;
  heading: string;
  intro: string;
  heroAction: string;
  newHeading: string;
  newAll: string;
  saleHeading: string;
  saleAll: string;
}> = {
  cs: {
    title: "Novinky a akce",
    heroAlt: "Imbusové šrouby v automatizované výrobě",
    badge: "NABÍDKA Z KATALOGU",
    heading: "Novinky a akce",
    intro:
      "Prohlédněte si výběr novinek a produkty označené v katalogu jako akční. Zobrazené prodejní ceny vycházejí z katalogu OntOS.",
    heroAction: "Zobrazit akční nabídku",
    newHeading: "Nové nerezové produkty v nabídce",
    newAll: "Zobrazit všechny novinky",
    saleHeading: "Akční nabídky a výprodej",
    saleAll: "Zobrazit celou akční nabídku",
  },
  sk: {
    title: "Novinky a akcie",
    heroAlt: "Imbusové skrutky vo automatizovanej výrobe",
    badge: "PONUKA Z KATALÓGU",
    heading: "Novinky a akcie",
    intro:
      "Pozrite si výber noviniek a produkty označené v katalógu ako akciové. Zobrazené predajné ceny vychádzajú z katalógu OntOS.",
    heroAction: "Zobraziť akčnú ponuku",
    newHeading: "Nové nerezové produkty v ponuke",
    newAll: "Zobraziť všetky novinky",
    saleHeading: "Akčné ponuky a výpredaj",
    saleAll: "Zobraziť celú akčnú ponuku",
  },
  en: {
    title: "New products and offers",
    heroAlt: "Hex socket bolts in automated production",
    badge: "FROM THE CATALOGUE",
    heading: "New products and offers",
    intro:
      "Browse our new products and the items marked as offers in the catalogue. The sale prices shown come from the OntOS catalogue.",
    heroAction: "View offers",
    newHeading: "New stainless steel products",
    newAll: "View all new products",
    saleHeading: "Special offers and clearance",
    saleAll: "View the full offer",
  },
};

/** Blog page chrome and the featured story (the four article cards come from `blogArticles`). */
export const blogCopy: PerLocale<{
  title: string;
  featuredAlt: string;
  badge: string;
  date: string;
  featuredTitle: string;
  featuredExcerpt: string;
  readFull: string;
  readingTime: string;
  latest: string;
  readMore: string;
  toolsLabel: string;
  searchHeading: string;
  searchLabel: string;
  searchPlaceholder: string;
  popularHeading: string;
  tags: readonly string[];
}> = {
  cs: {
    title: "Blog",
    featuredAlt: "Nerezové šrouby třídy A2 a A4",
    badge: "NÁVODY A RADY",
    date: "12. února 2026",
    featuredTitle: "Nerezová ocel A2 vs A4: Kompletní průvodce pro správnou volbu",
    featuredExcerpt:
      "Často se setkáváme s otázkou, který nerezový spojovací materiál zvolit. Je pro venkovní terasu lepší A2, nebo kyselinovzdorná A4? Podíváme se na odolnost vůči solím a praktické příklady z praxe.",
    readFull: "Přečíst celý článek",
    readingTime: "Doba čtení: 6 min",
    latest: "Nejnovější příspěvky",
    readMore: "Číst více →",
    toolsLabel: "Nástroje blogu",
    searchHeading: "Hledat v článcích",
    searchLabel: "Hledat v článcích",
    searchPlaceholder: "Zadejte hledané slovo…",
    popularHeading: "Populární témata",
    tags: ["# nerez-a2-vs-a4", "# fotovoltaika-montaz", "# utahovaci-momenty", "# normy-din-iso"],
  },
  sk: {
    title: "Blog",
    featuredAlt: "Nerezové skrutky triedy A2 a A4",
    badge: "NÁVODY A RADY",
    date: "12. februára 2026",
    featuredTitle: "Nerezová oceľ A2 vs A4: kompletný sprievodca správnou voľbou",
    featuredExcerpt:
      "Často sa stretávame s otázkou, aký nerezový spojovací materiál zvoliť. Je pre vonkajšiu terasu lepšia A2, alebo kyselinovzdorná A4? Pozrieme sa na odolnosť voči soliam a praktické príklady z praxe.",
    readFull: "Prečítať celý článok",
    readingTime: "Čas čítania: 6 min",
    latest: "Najnovšie príspevky",
    readMore: "Čítať viac →",
    toolsLabel: "Nástroje blogu",
    searchHeading: "Hľadať v článkoch",
    searchLabel: "Hľadať v článkoch",
    searchPlaceholder: "Zadajte hľadané slovo…",
    popularHeading: "Populárne témy",
    tags: ["# nerez-a2-vs-a4", "# fotovoltaika-montaz", "# utahovacie-momenty", "# normy-din-iso"],
  },
  en: {
    title: "Blog",
    featuredAlt: "Stainless steel A2 and A4 bolts",
    badge: "GUIDES AND ADVICE",
    date: "12 February 2026",
    featuredTitle: "Stainless steel A2 vs A4: the complete guide to choosing the right one",
    featuredExcerpt:
      "We are often asked which stainless fastener to choose. Is A2 better for an outdoor terrace, or is the acid-resistant A4 the better option? We look at salt resistance and practical examples from the field.",
    readFull: "Read the full article",
    readingTime: "Reading time: 6 min",
    latest: "Latest posts",
    readMore: "Read more →",
    toolsLabel: "Blog tools",
    searchHeading: "Search articles",
    searchLabel: "Search articles",
    searchPlaceholder: "Enter a search term…",
    popularHeading: "Popular topics",
    tags: [
      "# stainless-a2-vs-a4",
      "# solar-mounting",
      "# tightening-torques",
      "# din-iso-standards",
    ],
  },
};
