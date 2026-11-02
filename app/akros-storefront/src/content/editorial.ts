import type { BlogArticle, PerLocale } from "@/brand/types";

export interface FaqItem {
  question: string;
  answer: string;
  details: readonly string[];
}

export type FaqGroupId = "objednavky" | "doprava" | "reklamace" | "produkty";

export interface FaqGroup {
  id: FaqGroupId;
  title: string;
  items: readonly FaqItem[];
}

/** Chrome of the FAQ page and its explorer (labels around the questions). */
export interface FaqChrome {
  pageTitle: string;
  badge: string;
  heading: string;
  searchLabel: string;
  searchPlaceholder: string;
  categoriesLabel: string;
  categoriesHeading: string;
  resultsHeading: string;
  noResults: string;
  contactHeading: string;
  contactText: string;
}

export interface FaqCopy {
  chrome: FaqChrome;
  groups: readonly FaqGroup[];
}

const faqCs = (inquiryEmail: string): FaqCopy => ({
  chrome: {
    pageTitle: "Často kladené otázky",
    badge: "ZÁKAZNICKÁ PODPORA",
    heading: "Jak vám můžeme dnes pomoci?",
    searchLabel: "Hledat v často kladených otázkách",
    searchPlaceholder: "Hledejte v často kladených otázkách (např. normy, dodání, certifikáty)…",
    categoriesLabel: "Kategorie často kladených otázek",
    categoriesHeading: "Kategorie témat",
    resultsHeading: "Výsledky hledání",
    noResults: "Pro zadaný výraz jsme nenašli žádnou odpověď.",
    contactHeading: "Nenašli jste odpověď?",
    contactText: "Napište nám svůj dotaz a naši specialisté na spojovací materiál se vám ozvou.",
  },
  groups: [
    {
      id: "objednavky",
      title: "Objednávky a platby",
      items: [
        {
          question: "Jak dlouho trvá vyřízení objednávky?",
          answer: "Zboží skladem expedujeme do 24 hodin od přijetí objednávky.",
          details: [
            "Objednávky přijaté v pracovní den zpracováváme průběžně. U položek skladem obvykle předáme zásilku dopravci do 24 hodin a potvrzení o expedici pošleme e-mailem.",
            "U zboží na objednávku vám před potvrzením nákupu upřesníme dostupnost i očekávaný termín. Větší nebo kombinované objednávky mohou vyžadovat delší kompletaci, o které vás budeme průběžně informovat.",
          ],
        },
        {
          question: "Je možné objednat nerezový spojovací materiál na zakázku?",
          answer: `Ano, nabízíme zakázkovou výrobu dle výkresů. Kontaktujte nás na ${inquiryEmail}.`,
          details: [
            "Zakázkově umíme zajistit atypické rozměry, nestandardní délky i výrobu podle technického výkresu. Do poptávky přiložte požadovanou normu, materiál, povrchovou úpravu a orientační množství.",
            "Technik podklady zkontroluje a případně si vyžádá doplnění tolerancí nebo způsobu použití. Poté vám připravíme nezávaznou cenovou nabídku včetně minimálního odběru a předpokládaného termínu dodání.",
          ],
        },
        {
          question: "Jaký je rozdíl mezi nerezí A2 a A4?",
          answer:
            "A2 je klasická potravinářská nerez. A4 obsahuje molybden a odolá i kyselinám a mořské vodě.",
          details: [
            "Nerez A2 je vhodná pro většinu běžných aplikací v interiéru, potravinářství a méně agresivním venkovním prostředí. A4 obsahuje molybden, a proto lépe odolává chloridům, kyselinám a dlouhodobému působení vlhkosti.",
            "Pro instalace u bazénů, v chemických provozech nebo v přímořském prostředí proto zpravidla doporučujeme A4. Pokud rozhoduje konkrétní norma nebo certifikace, pošlete nám popis použití a vhodnou jakost společně ověříme.",
          ],
        },
        {
          question: "Poskytujete množstevní slevy pro firmy?",
          answer: "Ano, pro registrované firemní partnery nabízíme individuální ceníky a slevy.",
          details: [
            "Registrovaným firemním zákazníkům můžeme nastavit individuální ceny podle odebíraného sortimentu, objemu a pravidelnosti nákupů. Sleva se proto může u jednotlivých produktových skupin lišit.",
            "Po registraci nám pošlete IČO a stručnou představu o plánovaných odběrech. Obchodní oddělení vám připraví nabídku na míru a vysvětlí také možnosti rámcových objednávek nebo pravidelného zásobování.",
          ],
        },
        {
          question: "Mohu změnit položky v již odeslané objednávce?",
          answer: "Změna je možná telefonicky do okamžiku, než je zásilka předána dopravci.",
          details: [
            "Pokud objednávka ještě nebyla předána do skladu nebo dopravci, pokusíme se upravit množství, variantu i dodací údaje. Připravte si číslo objednávky a kontaktujte nás co nejdříve telefonicky nebo e-mailem.",
            "Po zahájení balení nemusí být změna vždy možná a po expedici už obsah zásilky upravit nelze. V takovém případě s vámi domluvíme nejvhodnější další postup nebo vytvoření doplňující objednávky.",
          ],
        },
      ],
    },
    {
      id: "doprava",
      title: "Doprava a doručení",
      items: [
        {
          question: "Jaké dopravce mohu využít?",
          answer:
            "Objednávku doručíme prostřednictvím PPL, DPD nebo Zásilkovny. K dispozici je také osobní odběr.",
          details: [
            "Konkrétní nabídka dopravců se řídí rozměry, hmotností a cílovou adresou zásilky. U nadrozměrného hutního materiálu se může zobrazit pouze paletová přeprava nebo individuální nacenění.",
            "Všechny dostupné možnosti, cenu a orientační termín doručení uvidíte v pokladně ještě před odesláním objednávky. Osobní odběr je možný po potvrzení připravenosti zboží.",
          ],
        },
        {
          question: "Jak zjistím stav zásilky?",
          answer:
            "Po expedici obdržíte číslo zásilky. V prototypu můžete otevřít ukázkové sledování zásilky.",
          details: [
            "Po převzetí zásilky dopravcem vám pošleme e-mail s číslem balíku a odkazem na sledování. Aktualizace se může u dopravce zobrazit s krátkým zpožděním po prvním naskenování.",
            "Registrovaní zákazníci najdou stav také v historii objednávek. Pokud se stav několik pracovních dnů nezmění, kontaktujte nás a zásilku prověříme přímo u dopravce.",
          ],
        },
      ],
    },
    {
      id: "reklamace",
      title: "Reklamace a vrácení",
      items: [
        {
          question: "Jak mohu zboží reklamovat?",
          answer: "Napište nám číslo objednávky a popis závady. Náš tým vám pošle další postup.",
          details: [
            "Do zprávy uveďte číslo objednávky, kód výrobku, množství a stručný popis závady. Fotografie produktu, štítku a přepravního obalu nám pomohou reklamaci posoudit rychleji.",
            "Po přijetí podkladů vám potvrdíme evidenci reklamace a zašleme další postup. Zboží neposílejte zpět bez předchozí domluvy, aby bylo možné zásilku správně přiřadit.",
          ],
        },
        {
          question: "Lze nepoužité zboží vrátit?",
          answer: "Standardní skladové zboží lze po domluvě vrátit v původním stavu a balení.",
          details: [
            "Vrácené zboží musí být kompletní, nepoužité a pokud možno v původním obalu. Před odesláním nám napište číslo objednávky a seznam položek, které chcete vrátit.",
            "Zakázkově vyrobené, zkrácené nebo jinak upravené produkty mohou mít odlišné podmínky a nemusí být možné je přijmout zpět. Konkrétní postup s vámi vždy potvrdí zákaznická podpora.",
          ],
        },
      ],
    },
    {
      id: "produkty",
      title: "Produkty a materiály",
      items: [
        {
          question: "Kde najdu normu DIN nebo ISO?",
          answer: "Norma je uvedena v názvu produktu, kódu a technickém popisu produktu.",
          details: [
            "Označení normy najdete v názvu produktu, technickém popisu a často také v tabulce variant. U některých položek uvádíme více ekvivalentních norem DIN, ISO nebo ČSN.",
            "Pokud hledáte náhradu starší normy nebo výrobek podle výkresu, pošlete nám označení a základní rozměry. Technická podpora pomůže ověřit kompatibilitu i dostupnou materiálovou variantu.",
          ],
        },
        {
          question: "Pomůžete mi s výběrem materiálu?",
          answer:
            "Ano. Pošlete nám popis použití nebo výkres a doporučíme vhodnou jakost i rozměr.",
          details: [
            "Pro doporučení potřebujeme znát prostředí použití, očekávané zatížení, teplotu a případný kontakt s chemikáliemi nebo slanou vodou. U spojovacího materiálu pomůže také informace o protikusu a způsobu montáže.",
            "Na základě těchto údajů navrhneme vhodnou jakost nerezi, rozměr a odpovídající normu. U bezpečnostně důležitých aplikací doporučení doplníme požadavkem na ověření projektantem nebo konstruktérem.",
          ],
        },
      ],
    },
  ],
});

const faqSk = (inquiryEmail: string): FaqCopy => ({
  chrome: {
    pageTitle: "Často kladené otázky",
    badge: "ZÁKAZNÍCKA PODPORA",
    heading: "Ako vám dnes môžeme pomôcť?",
    searchLabel: "Hľadať v často kladených otázkach",
    searchPlaceholder: "Hľadajte v často kladených otázkach (napr. normy, doručenie, certifikáty)…",
    categoriesLabel: "Kategórie často kladených otázok",
    categoriesHeading: "Kategórie tém",
    resultsHeading: "Výsledky vyhľadávania",
    noResults: "Pre zadaný výraz sme nenašli žiadnu odpoveď.",
    contactHeading: "Nenašli ste odpoveď?",
    contactText: "Napíšte nám svoju otázku a naši špecialisti na spojovací materiál sa vám ozvú.",
  },
  groups: [
    {
      id: "objednavky",
      title: "Objednávky a platby",
      items: [
        {
          question: "Ako dlho trvá vybavenie objednávky?",
          answer: "Tovar na sklade expedujeme do 24 hodín od prijatia objednávky.",
          details: [
            "Objednávky prijaté v pracovný deň spracúvame priebežne. Pri položkách na sklade zvyčajne odovzdáme zásielku prepravcovi do 24 hodín a potvrdenie o expedícii pošleme e-mailom.",
            "Pri tovare na objednávku vám pred potvrdením nákupu upresníme dostupnosť aj očakávaný termín. Väčšie alebo kombinované objednávky môžu vyžadovať dlhšie komplektovanie, o ktorom vás budeme priebežne informovať.",
          ],
        },
        {
          question: "Dá sa objednať nerezový spojovací materiál na zákazku?",
          answer: `Áno, ponúkame zákazkovú výrobu podľa výkresov. Kontaktujte nás na ${inquiryEmail}.`,
          details: [
            "Na zákazku zabezpečíme atypické rozmery, nestandardné dĺžky aj výrobu podľa technického výkresu. Do dopytu priložte požadovanú normu, materiál, povrchovú úpravu a orientačné množstvo.",
            "Technik podklady skontroluje a prípadne si vyžiada doplnenie tolerancií alebo spôsobu použitia. Potom vám pripravíme nezáväznú cenovú ponuku vrátane minimálneho odberu a predpokladaného termínu dodania.",
          ],
        },
        {
          question: "Aký je rozdiel medzi nerezou A2 a A4?",
          answer:
            "A2 je klasická potravinárska nerez. A4 obsahuje molybdén a odolá aj kyselinám a morskej vode.",
          details: [
            "Nerez A2 je vhodná pre väčšinu bežných aplikácií v interiéri, v potravinárstve a pri menej agresívnom vonkajšom prostredí. A4 obsahuje molybdén, a preto lepšie odoláva chloridom, kyselinám a dlhodobému pôsobeniu vlhkosti.",
            "Pri inštaláciách pri bazénoch, v chemických prevádzkach alebo v prímorskom prostredí preto zvyčajne odporúčame A4. Ak rozhoduje konkrétna norma alebo certifikácia, pošlite nám opis použitia a vhodnú akosť spoločne overíme.",
          ],
        },
        {
          question: "Poskytujete množstevné zľavy pre firmy?",
          answer:
            "Áno, pre registrovaných firemných partnerov ponúkame individuálne cenníky a zľavy.",
          details: [
            "Registrovaným firemným zákazníkom môžeme nastaviť individuálne ceny podľa odoberaného sortimentu, objemu a pravidelnosti nákupov. Zľava sa preto môže pri jednotlivých skupinách produktov líšiť.",
            "Po registrácii nám pošlite IČO a stručnú predstavu o plánovaných odberoch. Obchodné oddelenie vám pripraví ponuku na mieru a vysvetlí aj možnosti rámcových objednávok alebo pravidelného zásobovania.",
          ],
        },
        {
          question: "Môžem zmeniť položky v už odoslanej objednávke?",
          answer: "Zmena je možná telefonicky, kým zásielka nie je odovzdaná prepravcovi.",
          details: [
            "Ak objednávka ešte nebola odovzdaná do skladu ani prepravcovi, pokúsime sa upraviť množstvo, variant aj dodacie údaje. Pripravte si číslo objednávky a kontaktujte nás čo najskôr telefonicky alebo e-mailom.",
            "Po začatí balenia nemusí byť zmena vždy možná a po expedícii už obsah zásielky upraviť nie je možné. V takom prípade s vami dohodneme najvhodnejší ďalší postup alebo vytvorenie doplnkovej objednávky.",
          ],
        },
      ],
    },
    {
      id: "doprava",
      title: "Doprava a doručenie",
      items: [
        {
          question: "Akých prepravcov môžem využiť?",
          answer:
            "Objednávku doručíme prostredníctvom PPL, DPD alebo Zásielkovne. K dispozícii je aj osobný odber.",
          details: [
            "Konkrétna ponuka prepravcov sa riadi rozmermi, hmotnosťou a cieľovou adresou zásielky. Pri nadrozmernom hutnom materiáli sa môže zobraziť iba paletová preprava alebo individuálne ocenenie.",
            "Všetky dostupné možnosti, cenu a orientačný termín doručenia uvidíte v pokladni ešte pred odoslaním objednávky. Osobný odber je možný po potvrdení pripravenosti tovaru.",
          ],
        },
        {
          question: "Ako zistím stav zásielky?",
          answer:
            "Po expedícii dostanete číslo zásielky. V prototype si môžete otvoriť ukážkové sledovanie zásielky.",
          details: [
            "Po prevzatí zásielky prepravcom vám pošleme e-mail s číslom balíka a odkazom na sledovanie. Aktualizácia sa môže u prepravcu zobraziť s krátkym oneskorením po prvom naskenovaní.",
            "Registrovaní zákazníci nájdu stav aj v histórii objednávok. Ak sa stav niekoľko pracovných dní nezmení, kontaktujte nás a zásielku preveríme priamo u prepravcu.",
          ],
        },
      ],
    },
    {
      id: "reklamace",
      title: "Reklamácie a vrátenie",
      items: [
        {
          question: "Ako môžem tovar reklamovať?",
          answer: "Napíšte nám číslo objednávky a popis chyby. Náš tím vám pošle ďalší postup.",
          details: [
            "Do správy uveďte číslo objednávky, kód výrobku, množstvo a stručný popis chyby. Fotografie produktu, štítku a prepravného obalu nám pomôžu reklamáciu posúdiť rýchlejšie.",
            "Po prijatí podkladov vám potvrdíme evidenciu reklamácie a zašleme ďalší postup. Tovar neposielajte späť bez predchádzajúcej dohody, aby bolo možné zásielku správne priradiť.",
          ],
        },
        {
          question: "Dá sa nepoužitý tovar vrátiť?",
          answer: "Štandardný skladový tovar možno po dohode vrátiť v pôvodnom stave a balení.",
          details: [
            "Vrátený tovar musí byť kompletný, nepoužitý a pokiaľ možno v pôvodnom obale. Pred odoslaním nám napíšte číslo objednávky a zoznam položiek, ktoré chcete vrátiť.",
            "Na zákazku vyrobené, skrátené alebo inak upravené produkty môžu mať odlišné podmienky a nemusí byť možné ich prijať späť. Konkrétny postup vám vždy potvrdí zákaznícka podpora.",
          ],
        },
      ],
    },
    {
      id: "produkty",
      title: "Produkty a materiály",
      items: [
        {
          question: "Kde nájdem normu DIN alebo ISO?",
          answer: "Norma je uvedená v názve produktu, v kóde a v technickom popise produktu.",
          details: [
            "Označenie normy nájdete v názve produktu, v technickom popise a často aj v tabuľke variantov. Pri niektorých položkách uvádzame viacero ekvivalentných noriem DIN, ISO alebo STN.",
            "Ak hľadáte náhradu staršej normy alebo výrobok podľa výkresu, pošlite nám označenie a základné rozmery. Technická podpora pomôže overiť kompatibilitu aj dostupnú materiálovú variantu.",
          ],
        },
        {
          question: "Pomôžete mi s výberom materiálu?",
          answer:
            "Áno. Pošlite nám opis použitia alebo výkres a odporúčame vhodnú akosť aj rozmer.",
          details: [
            "Na odporúčanie potrebujeme poznať prostredie použitia, očakávané zaťaženie, teplotu a prípadný kontakt s chemikáliami alebo slanou vodou. Pri spojovacom materiáli pomôže aj informácia o protikuse a spôsobe montáže.",
            "Na základe týchto údajov navrhneme vhodnú akosť nerezi, rozmer a zodpovedajúcu normu. Pri bezpečnostne dôležitých aplikáciách odporúčanie doplníme požiadavkou na overenie projektantom alebo konštruktérom.",
          ],
        },
      ],
    },
  ],
});

const faqEn = (inquiryEmail: string): FaqCopy => ({
  chrome: {
    pageTitle: "Frequently asked questions",
    badge: "CUSTOMER SUPPORT",
    heading: "How can we help you today?",
    searchLabel: "Search the frequently asked questions",
    searchPlaceholder: "Search the FAQ (e.g. standards, delivery, certificates)…",
    categoriesLabel: "Frequently asked question categories",
    categoriesHeading: "Topics",
    resultsHeading: "Search results",
    noResults: "We could not find an answer for that search.",
    contactHeading: "Didn't find your answer?",
    contactText: "Send us your question and our fastener specialists will get back to you.",
  },
  groups: [
    {
      id: "objednavky",
      title: "Orders and payment",
      items: [
        {
          question: "How long does it take to process an order?",
          answer: "We dispatch items in stock within 24 hours of receiving your order.",
          details: [
            "We process orders received on working days as they come in. For items in stock, we usually hand the parcel to the carrier within 24 hours and send you a dispatch confirmation by e-mail.",
            "For made-to-order goods, we confirm availability and the expected lead time before you complete your purchase. Larger or mixed orders may need longer to put together, and we will keep you updated.",
          ],
        },
        {
          question: "Can I order stainless fasteners made to order?",
          answer: `Yes, we offer custom manufacturing to drawings. Contact us at ${inquiryEmail}.`,
          details: [
            "We can supply non-standard sizes, unusual lengths and parts made to a technical drawing. Please include the required standard, material, surface finish and approximate quantity in your enquiry.",
            "Our technician will check the documents and, if needed, ask for tolerances or the intended use. We will then prepare a non-binding quote that includes the minimum order quantity and the estimated delivery date.",
          ],
        },
        {
          question: "What is the difference between A2 and A4 stainless steel?",
          answer:
            "A2 is classic food-grade stainless steel. A4 contains molybdenum and also resists acids and sea water.",
          details: [
            "A2 suits most everyday indoor applications, food processing and less aggressive outdoor conditions. A4 contains molybdenum, so it resists chlorides, acids and long-term exposure to moisture better.",
            "For installations by swimming pools, in chemical plants or in coastal areas, we usually recommend A4. If a specific standard or certificate applies, send us a description of the use and we will confirm a suitable grade together.",
          ],
        },
        {
          question: "Do you offer volume discounts for businesses?",
          answer:
            "Yes, registered business customers can get individual price lists and discounts.",
          details: [
            "We can set individual prices for registered business customers based on the range they buy, the volume and how regularly they order. Discounts may therefore differ between product groups.",
            "After registration, send us your company ID (IČO) and a brief outline of your planned purchases. Our sales team will prepare a tailored offer and explain framework orders or regular supply options.",
          ],
        },
        {
          question: "Can I change items in an order I have already placed?",
          answer: "Changes are possible by phone until the parcel is handed to the carrier.",
          details: [
            "If the order has not yet gone to the warehouse or the carrier, we will try to change the quantity, variant and delivery details. Have your order number ready and contact us as soon as possible by phone or e-mail.",
            "Once packing has started, a change may not always be possible, and the contents cannot be altered after dispatch. In that case we will agree the best next step with you, such as a supplementary order.",
          ],
        },
      ],
    },
    {
      id: "doprava",
      title: "Delivery",
      items: [
        {
          question: "Which carriers can I use?",
          answer: "We deliver with PPL, DPD or Zásilkovna. Collection in person is also available.",
          details: [
            "The carrier options depend on the size, weight and destination of the parcel. For oversized steel products, only pallet freight or an individual quote may be shown.",
            "You will see all available options, the price and an estimated delivery date at checkout before you place your order. Collection in person is possible once the goods are confirmed as ready.",
          ],
        },
        {
          question: "How do I track my parcel?",
          answer:
            "You will receive a parcel number once the order is dispatched. In the prototype you can open the demo tracking page.",
          details: [
            "When the carrier collects the parcel, we will e-mail you the parcel number and a tracking link. Updates may appear with a short delay after the first scan.",
            "Registered customers can also see the status in their order history. If it does not change for several working days, contact us and we will check the parcel directly with the carrier.",
          ],
        },
      ],
    },
    {
      id: "reklamace",
      title: "Complaints and returns",
      items: [
        {
          question: "How do I make a complaint about goods?",
          answer:
            "Send us your order number and a description of the fault. Our team will tell you what happens next.",
          details: [
            "Include the order number, product code, quantity and a short description of the fault. Photos of the product, its label and the shipping packaging help us assess the complaint more quickly.",
            "Once we have the details, we will confirm that the complaint is logged and send you the next steps. Please do not return goods without agreeing it with us first, so that we can match the parcel correctly.",
          ],
        },
        {
          question: "Can I return unused goods?",
          answer:
            "Standard stock items can be returned in their original condition and packaging, by prior agreement.",
          details: [
            "Returned goods must be complete, unused and, where possible, in their original packaging. Before sending anything back, e-mail us your order number and a list of the items you want to return.",
            "Made-to-order, cut-to-length or otherwise modified products may have different conditions and may not be possible to take back. Customer support will always confirm the exact procedure with you.",
          ],
        },
      ],
    },
    {
      id: "produkty",
      title: "Products and materials",
      items: [
        {
          question: "Where can I find the DIN or ISO standard?",
          answer: "The standard is stated in the product name, code and technical description.",
          details: [
            "You will find the standard in the product name, the technical description and often in the variant table. For some items we list several equivalent DIN, ISO or other national standards.",
            "If you are looking for a replacement for an older standard or a product made to a drawing, send us the reference and the main dimensions. Technical support will help check compatibility and the available material grade.",
          ],
        },
        {
          question: "Can you help me choose the right material?",
          answer:
            "Yes. Send us a description of the use or a drawing and we will recommend a suitable grade and size.",
          details: [
            "To make a recommendation, we need to know the environment, the expected load, the temperature and any contact with chemicals or salt water. For fasteners, information about the mating part and the fitting method also helps.",
            "Based on this, we will suggest a suitable stainless grade, size and matching standard. For safety-critical applications, we will ask you to have the recommendation checked by a structural engineer or designer.",
          ],
        },
      ],
    },
  ],
});

/** FAQ of the shop per language; `inquiryEmail` is the brand's address for custom manufacturing inquiries. */
export const faqCopy: PerLocale<(inquiryEmail: string) => FaqCopy> = {
  cs: faqCs,
  sk: faqSk,
  en: faqEn,
};

/** Blog articles per language, illustrated with the brand's four images (in article order). */
const blogArticlesCs = (images: readonly string[]): readonly BlogArticle[] => [
  {
    title: "Jak vybrat správný šroub pro venkovní použití",
    date: "5. února 2026",
    category: "Projekty",
    excerpt:
      "Venkovní konstrukce vyžadují materiály, které odolají dešti i mrazu. Připravili jsme přehled norem pro spojovací materiál.",
    imageSrc: images[0] ?? "",
  },
  {
    title: "Správné utahovací momenty pro nerezové spoje",
    date: "28. ledna 2026",
    category: "Technická podpora",
    excerpt:
      "Přetažení šroubu z nerezové oceli může způsobit jeho zadření. Naučte se správné utahovací momenty pro závity M4 až M20.",
    imageSrc: images[1] ?? "",
  },
  {
    title: "Novinky v sortimentu pro rok 2026",
    date: "15. ledna 2026",
    category: "Novinky",
    excerpt:
      "Rozšiřujeme skladové zásoby spojovacího materiálu o další tisíce kusů certifikovaných norem DIN a ISO.",
    imageSrc: images[2] ?? "",
  },
  {
    title: "Fotovoltaické konstrukce: na co nezapomenout",
    date: "3. ledna 2026",
    category: "Fotovoltaika",
    excerpt:
      "Instalace solárních panelů na střechu vyžaduje robustní a korozi odolné nerezové profily i spojovací materiál.",
    imageSrc: images[3] ?? "",
  },
];

const blogArticlesSk = (images: readonly string[]): readonly BlogArticle[] => [
  {
    title: "Ako vybrať správnu skrutku na vonkajšie použitie",
    date: "5. februára 2026",
    category: "Projekty",
    excerpt:
      "Vonkajšie konštrukcie vyžadujú materiály, ktoré odolajú dažďu aj mrazu. Pripravili sme prehľad noriem pre spojovací materiál.",
    imageSrc: images[0] ?? "",
  },
  {
    title: "Správne uťahovacie momenty pre nerezové spoje",
    date: "28. januára 2026",
    category: "Technická podpora",
    excerpt:
      "Pretiahnutie skrutky z nerezovej ocele môže spôsobiť jej zadretie. Naučte sa správne uťahovacie momenty pre závity M4 až M20.",
    imageSrc: images[1] ?? "",
  },
  {
    title: "Novinky v sortimente pre rok 2026",
    date: "15. januára 2026",
    category: "Novinky",
    excerpt:
      "Rozširujeme skladové zásoby spojovacieho materiálu o ďalšie tisíce kusov certifikovaných noriem DIN a ISO.",
    imageSrc: images[2] ?? "",
  },
  {
    title: "Fotovoltické konštrukcie: na čo nezabudnúť",
    date: "3. januára 2026",
    category: "Fotovoltika",
    excerpt:
      "Montáž solárnych panelov na strechu vyžaduje robustné a koróziu odolné nerezové profily aj spojovací materiál.",
    imageSrc: images[3] ?? "",
  },
];

const blogArticlesEn = (images: readonly string[]): readonly BlogArticle[] => [
  {
    title: "How to choose the right screw for outdoor use",
    date: "5 February 2026",
    category: "Projects",
    excerpt:
      "Outdoor structures need materials that withstand rain and frost. We have put together an overview of standards for fasteners.",
    imageSrc: images[0] ?? "",
  },
  {
    title: "Correct tightening torques for stainless joints",
    date: "28 January 2026",
    category: "Technical support",
    excerpt:
      "Overtightening a stainless steel screw can make it seize. Learn the correct tightening torques for M4 to M20 threads.",
    imageSrc: images[1] ?? "",
  },
  {
    title: "New range additions for 2026",
    date: "15 January 2026",
    category: "News",
    excerpt: "We are adding thousands more pieces of certified DIN and ISO fasteners to our stock.",
    imageSrc: images[2] ?? "",
  },
  {
    title: "Solar mounting structures: what not to forget",
    date: "3 January 2026",
    category: "Solar",
    excerpt:
      "Mounting solar panels on a roof needs sturdy, corrosion-resistant stainless profiles and fasteners.",
    imageSrc: images[3] ?? "",
  },
];

/** The brand's blog articles in every brand language, with the brand's four images in article order. */
export const blogArticles = (
  images: readonly [string, string, string, string],
): PerLocale<readonly BlogArticle[]> => ({
  cs: blogArticlesCs(images),
  sk: blogArticlesSk(images),
  en: blogArticlesEn(images),
});
