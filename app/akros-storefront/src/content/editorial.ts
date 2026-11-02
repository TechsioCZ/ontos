import type { BlogArticle } from "@/brand/types";

/** FAQ of the shop; `inquiryEmail` is the brand's address for custom manufacturing inquiries. */
export const faqGroups = (inquiryEmail: string) =>
  [
    {
      id: "objednavky",
      title: "Objednávky a platby",
      items: [
        [
          "Jak dlouho trvá vyřízení objednávky?",
          "Zboží skladem expedujeme do 24 hodin od přijetí objednávky.",
          [
            "Objednávky přijaté v pracovní den zpracováváme průběžně. U položek skladem obvykle předáme zásilku dopravci do 24 hodin a potvrzení o expedici pošleme e-mailem.",
            "U zboží na objednávku vám před potvrzením nákupu upřesníme dostupnost i očekávaný termín. Větší nebo kombinované objednávky mohou vyžadovat delší kompletaci, o které vás budeme průběžně informovat.",
          ],
        ],
        [
          "Je možné objednat nerezový spojovací materiál na zakázku?",
          `Ano, nabízíme zakázkovou výrobu dle výkresů. Kontaktujte nás na ${inquiryEmail}.`,
          [
            "Zakázkově umíme zajistit atypické rozměry, nestandardní délky i výrobu podle technického výkresu. Do poptávky přiložte požadovanou normu, materiál, povrchovou úpravu a orientační množství.",
            "Technik podklady zkontroluje a případně si vyžádá doplnění tolerancí nebo způsobu použití. Poté vám připravíme nezávaznou cenovou nabídku včetně minimálního odběru a předpokládaného termínu dodání.",
          ],
        ],
        [
          "Jaký je rozdíl mezi nerezí A2 a A4?",
          "A2 je klasická potravinářská nerez. A4 obsahuje molybden a odolá i kyselinám a mořské vodě.",
          [
            "Nerez A2 je vhodná pro většinu běžných aplikací v interiéru, potravinářství a méně agresivním venkovním prostředí. A4 obsahuje molybden, a proto lépe odolává chloridům, kyselinám a dlouhodobému působení vlhkosti.",
            "Pro instalace u bazénů, v chemických provozech nebo v přímořském prostředí proto zpravidla doporučujeme A4. Pokud rozhoduje konkrétní norma nebo certifikace, pošlete nám popis použití a vhodnou jakost společně ověříme.",
          ],
        ],
        [
          "Poskytujete množstevní slevy pro firmy?",
          "Ano, pro registrované firemní partnery nabízíme individuální ceníky a slevy.",
          [
            "Registrovaným firemním zákazníkům můžeme nastavit individuální ceny podle odebíraného sortimentu, objemu a pravidelnosti nákupů. Sleva se proto může u jednotlivých produktových skupin lišit.",
            "Po registraci nám pošlete IČO a stručnou představu o plánovaných odběrech. Obchodní oddělení vám připraví nabídku na míru a vysvětlí také možnosti rámcových objednávek nebo pravidelného zásobování.",
          ],
        ],
        [
          "Mohu změnit položky v již odeslané objednávce?",
          "Změna je možná telefonicky do okamžiku, než je zásilka předána dopravci.",
          [
            "Pokud objednávka ještě nebyla předána do skladu nebo dopravci, pokusíme se upravit množství, variantu i dodací údaje. Připravte si číslo objednávky a kontaktujte nás co nejdříve telefonicky nebo e-mailem.",
            "Po zahájení balení nemusí být změna vždy možná a po expedici už obsah zásilky upravit nelze. V takovém případě s vámi domluvíme nejvhodnější další postup nebo vytvoření doplňující objednávky.",
          ],
        ],
      ],
    },
    {
      id: "doprava",
      title: "Doprava a doručení",
      items: [
        [
          "Jaké dopravce mohu využít?",
          "Objednávku doručíme prostřednictvím PPL, DPD nebo Zásilkovny. K dispozici je také osobní odběr.",
          [
            "Konkrétní nabídka dopravců se řídí rozměry, hmotností a cílovou adresou zásilky. U nadrozměrného hutního materiálu se může zobrazit pouze paletová přeprava nebo individuální nacenění.",
            "Všechny dostupné možnosti, cenu a orientační termín doručení uvidíte v pokladně ještě před odesláním objednávky. Osobní odběr je možný po potvrzení připravenosti zboží.",
          ],
        ],
        [
          "Jak zjistím stav zásilky?",
          "Po expedici obdržíte číslo zásilky. V prototypu můžete otevřít ukázkové sledování zásilky.",
          [
            "Po převzetí zásilky dopravcem vám pošleme e-mail s číslem balíku a odkazem na sledování. Aktualizace se může u dopravce zobrazit s krátkým zpožděním po prvním naskenování.",
            "Registrovaní zákazníci najdou stav také v historii objednávek. Pokud se stav několik pracovních dnů nezmění, kontaktujte nás a zásilku prověříme přímo u dopravce.",
          ],
        ],
      ],
    },
    {
      id: "reklamace",
      title: "Reklamace a vrácení",
      items: [
        [
          "Jak mohu zboží reklamovat?",
          "Napište nám číslo objednávky a popis závady. Náš tým vám pošle další postup.",
          [
            "Do zprávy uveďte číslo objednávky, kód výrobku, množství a stručný popis závady. Fotografie produktu, štítku a přepravního obalu nám pomohou reklamaci posoudit rychleji.",
            "Po přijetí podkladů vám potvrdíme evidenci reklamace a zašleme další postup. Zboží neposílejte zpět bez předchozí domluvy, aby bylo možné zásilku správně přiřadit.",
          ],
        ],
        [
          "Lze nepoužité zboží vrátit?",
          "Standardní skladové zboží lze po domluvě vrátit v původním stavu a balení.",
          [
            "Vrácené zboží musí být kompletní, nepoužité a pokud možno v původním obalu. Před odesláním nám napište číslo objednávky a seznam položek, které chcete vrátit.",
            "Zakázkově vyrobené, zkrácené nebo jinak upravené produkty mohou mít odlišné podmínky a nemusí být možné je přijmout zpět. Konkrétní postup s vámi vždy potvrdí zákaznická podpora.",
          ],
        ],
      ],
    },
    {
      id: "produkty",
      title: "Produkty a materiály",
      items: [
        [
          "Kde najdu normu DIN nebo ISO?",
          "Norma je uvedena v názvu produktu, kódu a technickém popisu produktu.",
          [
            "Označení normy najdete v názvu produktu, technickém popisu a často také v tabulce variant. U některých položek uvádíme více ekvivalentních norem DIN, ISO nebo ČSN.",
            "Pokud hledáte náhradu starší normy nebo výrobek podle výkresu, pošlete nám označení a základní rozměry. Technická podpora pomůže ověřit kompatibilitu i dostupnou materiálovou variantu.",
          ],
        ],
        [
          "Pomůžete mi s výběrem materiálu?",
          "Ano. Pošlete nám popis použití nebo výkres a doporučíme vhodnou jakost i rozměr.",
          [
            "Pro doporučení potřebujeme znát prostředí použití, očekávané zatížení, teplotu a případný kontakt s chemikáliemi nebo slanou vodou. U spojovacího materiálu pomůže také informace o protikusu a způsobu montáže.",
            "Na základě těchto údajů navrhneme vhodnou jakost nerezi, rozměr a odpovídající normu. U bezpečnostně důležitých aplikací doporučení doplníme požadavkem na ověření projektantem nebo konstruktérem.",
          ],
        ],
      ],
    },
  ] as const;
export type FaqGroups = ReturnType<typeof faqGroups>;
export type FaqGroupId = FaqGroups[number]["id"];

/** Blog articles of the shop, illustrated with the brand's four images (in article order). */
export const blogArticles = (
  images: readonly [string, string, string, string],
): readonly BlogArticle[] => [
  {
    title: "Jak vybrat správný šroub pro venkovní použití",
    date: "5. února 2026",
    category: "Projekty",
    excerpt:
      "Venkovní konstrukce vyžadují materiály, které odolají dešti i mrazu. Připravili jsme přehled norem pro spojovací materiál.",
    imageSrc: images[0],
  },
  {
    title: "Správné utahovací momenty pro nerezové spoje",
    date: "28. ledna 2026",
    category: "Technická podpora",
    excerpt:
      "Přetažení šroubu z nerezové oceli může způsobit jeho zadření. Naučte se správné utahovací momenty pro závity M4 až M20.",
    imageSrc: images[1],
  },
  {
    title: "Novinky v sortimentu pro rok 2026",
    date: "15. ledna 2026",
    category: "Novinky",
    excerpt:
      "Rozšiřujeme skladové zásoby spojovacího materiálu o další tisíce kusů certifikovaných norem DIN a ISO.",
    imageSrc: images[2],
  },
  {
    title: "Fotovoltaické konstrukce: na co nezapomenout",
    date: "3. ledna 2026",
    category: "Fotovoltaika",
    excerpt:
      "Instalace solárních panelů na střechu vyžaduje robustní a korozi odolné nerezové profily i spojovací materiál.",
    imageSrc: images[3],
  },
];
