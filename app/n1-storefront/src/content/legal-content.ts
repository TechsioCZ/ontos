export type LegalBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "group"; paragraphs: readonly string[] }
  | { items: readonly string[]; kind: "list" };
export type LegalArticle = Readonly<{
  kind: "privacy" | "terms";
  language: "cs";
  sections: readonly { blocks: readonly LegalBlock[]; heading?: string }[];
  subtitle?: string;
  title: string;
}>;

/** Provided N1 editorial copy, not a CMS response or a native policy/version record.
 * Source: Figma50:867/1032 +50:1126/1288, matching the historical N1 static routes.
 * Czech is the only authored document language, including under English site chrome.
 */
export const legalArticles = {
  "obchodni-podminky": {
    kind: "terms",
    language: "cs",
    sections: [
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Tyto obchodní podmínky platí pro nákup v internetovém obchodě www.n1shop.cz provozovaném společností N Distribution s.r.o.",
          },
          {
            kind: "group",
            paragraphs: [
              "IČO: 03564274",
              "DIČ: CZ03564274",
              "Sídlo: Generála Šišky 1990/8, 143 00 Praha 4 - Modřany",
              "Zapsaná v obchodním rejstříku vedeném Městským soudem v Praze, oddíl C, vložka 233602",
            ],
          },
          {
            kind: "group",
            paragraphs: ["Telefon: +420 244 402 795", "Email: office@ndistribution.cz"],
          },
        ],
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Reklamaci lze uplatnit v zákonné lhůtě 24 měsíců od převzetí zboží. Reklamované zboží zašlete na naši adresu společně s popisem závady a dokladem o koupi.",
          },
          { kind: "paragraph", text: "Email pro reklamace: reklamace@n1shop.cz" },
        ],
        heading: "Reklamace vadného zboží",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Máte právo odstoupit od smlouvy do 14 dnů od převzetí zboží bez udání důvodu.",
          },
        ],
        heading: "Vrácení zboží",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Výměnu zboží za jinou velikost či barvu lze provést do 14 dnů od převzetí. Zboží musí být nepoškozené, nepoužité, s originálními visačkami.",
          },
        ],
        heading: "Výměna zboží",
      },
      {
        blocks: [
          {
            items: [
              "Rychlé doručení",
              "Kvalitní zákaznický servis",
              "Bezpečná platba",
              "Široký výběr zboží",
            ],
            kind: "list",
          },
        ],
        heading: "Proč nakupovat u nás",
      },
    ],
    subtitle: "Všeobecné obchodní podmínky pro spotřebitele",
    title: "Obchodní podmínky",
  },
  "ochrana-osobnich-udaju": {
    kind: "privacy",
    language: "cs",
    sections: [
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Kupující souhlasí se zpracováním těchto svých osobních údajů: jméno a příjmení, adresa bydliště, identifikační číslo, daňové identifikační číslo, adresa elektronické pošty, telefonní číslo.",
          },
        ],
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Osobní údaje jsou zpracovávány za účelem realizace práv a povinností z kupní smlouvy a za účelem vedení uživatelského účtu. Kupující souhlasí se zasíláním informací souvisejících se zbožím, službami nebo podnikem prodávajícího.",
          },
        ],
        heading: "Účel zpracování",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Zpracováním osobních údajů kupujícího může prodávající pověřit třetí osobu, jakožto zpracovatele. Osobní údaje nebudou předány třetím osobám mimo osoby dopravující zboží.",
          },
          {
            kind: "paragraph",
            text: "Osobní údaje budou zpracovávány po dobu neurčitou. Osobní údaje budou zpracovávány v elektronické podobě automatizovaným způsobem nebo v tištěné podobě neautomatizovaným způsobem.",
          },
        ],
        heading: "Zpracování údajů",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Kupující potvrzuje, že poskytnuté osobní údaje jsou přesné a že byl poučen o tom, že se jedná o dobrovolné poskytnutí osobních údajů.",
          },
          {
            kind: "paragraph",
            text: "V případě, že by se kupující domníval, že prodávající nebo zpracovatel provádí zpracování jeho osobních údajů, které je v rozporu s ochranou soukromého a osobního života kupujícího nebo v rozporu se zákonem, může požádat prodávajícího o vysvětlení nebo požadovat odstranění závadného stavu.",
          },
        ],
        heading: "Práva kupujícího",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Náš web používá soubory cookies pro zajištění správné funkčnosti webu. Rozlišujeme několik kategorií cookies:",
          },
          {
            items: [
              "Nezbytné cookies - nutné pro fungování webu",
              "Statistické cookies - pomáhají vylepšovat web",
              "Marketingové cookies - přizpůsobení reklamy",
            ],
            kind: "list",
          },
        ],
        heading: "Cookies",
      },
      {
        blocks: [
          {
            kind: "paragraph",
            text: "Správce osobních údajů: N Distribution s.r.o., IČO: 03564274",
          },
          { kind: "paragraph", text: "Email: office@ndistribution.cz" },
        ],
        heading: "Kontakt",
      },
    ],
    title: "Zásady ochrany osobních údajů",
  },
} satisfies Record<"obchodni-podminky" | "ochrana-osobnich-udaju", LegalArticle>;
