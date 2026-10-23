import type { DemoGuide, DemoGuidePersona } from '../demo-guide-types.ts';

const eshop: DemoGuidePersona = { email: 'eshop@akros.demo', role: 'Správce e-shopu' };
const expedice: DemoGuidePersona = { email: 'expedice@akros.demo', role: 'Expedice' };

/** Kai Uwe's standalone storefront uses its own customer account, separate from the staff sign-in. */
declare global {
  var ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT: string | undefined;
}
const storefront = globalThis.ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT ?? 'http://localhost:3070';
const productUrl = `${storefront}/produkt/srouby-s-valcovou-hlavou-s-vnitrnim-sestihranem-din-912-a2?variant=10091200010004`;

export const akrosGuide: DemoGuide = {
  chapters: [
    {
      id: 'nakup',
      steps: [
        {
          click:
            'Tlačítko otevře e-shop v nové kartě. Katalog je veřejný; objednání vyžaduje zákaznický účet e-shopu, nikoli účet správce OntOS.',
          id: 'akros-katalog',
          persona: null,
          say: 'Tohle je zákaznický e-shop AKROS se zachovaným vlastním designem. Katalog, ceny a dostupnost mu dodává OntOS.',
          target: { kind: 'external', label: 'e-shop AKROS', url: `${storefront}/` },
          title: 'E-shop AKROS',
        },
        {
          click: 'U SKU 10091200010004 vložte do košíku minimální balení 500 ks.',
          id: 'akros-varianta',
          persona: null,
          say: 'Zákazník vybírá konkrétní variantu a minimum i balení se řídí zdrojovými daty. Množstevní slevy neslibujeme, zdroj je nemá.',
          target: { kind: 'external', label: 'produkt v e-shopu', url: productUrl },
          title: 'Konkrétní varianta šroubu',
        },
        {
          click: 'Počkejte na hlášku „Ceny, množství a dostupnost byly ověřeny v OntOS.“',
          id: 'akros-kosik',
          persona: null,
          say: 'Před objednáním si e-shop ceny, množství a dostupnost znovu ověří přímo v OntOS.',
          target: { kind: 'external', label: 'košík', url: `${storefront}/kosik` },
          title: 'Košík ověřený v OntOS',
        },
        {
          click:
            'V košíku se nejprve přihlaste zákaznickým účtem e-shopu. Vyberte PPL nebo Českou poštu → Dodací údaje → Souhrn objednávky → jednou Odeslat objednávku → opište číslo objednávky.',
          id: 'akros-objednavka',
          persona: null,
          say: 'Objednávka se skutečně uloží a dostane číslo. Její stav je v zákaznickém účtu; odesláním neproběhne online platba ani objednání přepravy.',
          target: { kind: 'external', label: 'pokladnu', url: `${storefront}/kosik` },
          title: 'Dokončení objednávky',
        },
      ],
      summary: 'Zákazník nakupuje v původním e-shopu AKROS, OntOS dodává varianty, ceny a dostupnost.',
      title: 'Zákaznický nákup v e-shopu',
    },
    {
      id: 'sprava',
      steps: [
        {
          click:
            'Do pole Hledat podle čísla nebo zákazníka… vložte opsané číslo → otevřete řádek → porovnejte variantu, 500 ks a součet.',
          id: 'akros-objednavka-sprava',
          persona: eshop,
          say: 'Správce vidí stejnou objednávku, kterou zákazník právě odeslal, včetně varianty, množství a součtu.',
          target: { kind: 'app', path: '/prodej/objednavky' },
          title: 'Objednávka v administraci',
        },
        {
          click:
            'Varianty a ceny → hledat 10091200010004 → opište původní cenu → zvyšte ji o 0,01 Kč bez DPH → Uložit varianty.',
          id: 'akros-cena',
          persona: eshop,
          say: 'Cenu spravuje oprávněný pracovník v OntOS. Potvrzená objednávka má uložený cenový snímek, takže se zpětně nepřecení.',
          target: { kind: 'app', path: '/provoz/produkty/product-16732' },
          title: 'Změna ceny varianty',
        },
        {
          click: 'Po nejvýše deseti sekundách obnovte kartu s produktem v e-shopu.',
          id: 'akros-cena-eshop',
          persona: null,
          say: 'E-shop načte cenu s DPH z OntOS; před objednáním ji ještě znovu ověří.',
          target: { kind: 'external', label: 'produkt v e-shopu', url: productUrl },
          title: 'Nová cena v e-shopu',
        },
      ],
      summary: 'Správce vidí objednávku zákazníka a spravuje ceny variant.',
      title: 'Správa e-shopu v OntOS',
    },
    {
      id: 'expedice',
      steps: [
        {
          click:
            'Vyhledejte stejné číslo → detail → Začít zpracovávat → Připraveno k předání → Předat dopravci (simulace) → Dokončit.',
          id: 'akros-expedice-stavy',
          persona: expedice,
          say: 'Expedice posouvá skutečný stav objednávky, ale nemění její obsah ani ceny. Tento krok zatím nezajišťuje rezervaci přepravy ani štítek.',
          target: { kind: 'app', path: '/prodej/objednavky' },
          title: 'Zpracování objednávky',
        },
        {
          click: 'Ukažte, že ceny jsou jen ke čtení a Skladový pohyb varianty je dostupný. Pohyb neukládejte.',
          id: 'akros-expedice-sklad',
          persona: expedice,
          say: 'Expedice vidí ceny jen pro čtení, skladové pohyby ale může skutečně zapisovat.',
          target: { kind: 'app', path: '/provoz/produkty/product-16732' },
          title: 'Sklad bez práva na ceny',
        },
      ],
      summary: 'Expedice posouvá objednávku, ale nemění ji ani ceny.',
      title: 'Expedice',
    },
    {
      id: 'uklid',
      steps: [
        {
          click: 'Otevřete stejnou objednávku → Historie změn.',
          id: 'akros-historie',
          persona: eshop,
          say: 'Každý přechod objednávky má autora a čas, nic se tiše nepřepisuje.',
          target: { kind: 'app', path: '/prodej/objednavky' },
          title: 'Historie změn objednávky',
        },
        {
          click: 'Varianty a ceny → hledat 10091200010004 → vraťte přesně opsanou původní cenu → Uložit varianty.',
          id: 'akros-vratit-cenu',
          persona: eshop,
          say: 'I úklid po ukázce je řízená změna s historií cen.',
          target: { kind: 'app', path: '/provoz/produkty/product-16732' },
          title: 'Vrátit původní cenu',
        },
        {
          click:
            'Otevřete právě vytvořenou objednávku → Odstranit DEMO objednávku → uveďte důvod → Potvrdit odstranění DEMO.',
          id: 'akros-odstranit-demo',
          persona: eshop,
          say: 'Objednávka zmizí jen z prezentačního seznamu; doklad, historie i audit zůstávají.',
          target: { kind: 'app', path: '/prodej/objednavky' },
          title: 'Odstranit DEMO objednávku',
        },
      ],
      summary: 'Každý krok má autora a čas; po ukázce vše vrátíme řízenou akcí.',
      title: 'Historie a úklid',
    },
    {
      id: 'pripojeni-ai',
      steps: [
        {
          click: 'Menu účtu › Můj profil › Připojené aplikace › Jak připojit › Kopírovat adresu.',
          id: 'akros-mcp-adresa',
          persona: expedice,
          say: 'Do ChatGPT nebo Claude se vkládá jen adresa serveru, žádný klíč ani token. Přihlášení a souhlas proběhnou v OntOS.',
          target: { kind: 'app', path: '/profil' },
          title: 'Jedna adresa pro ChatGPT i Claude',
        },
        {
          click:
            'V Claude Code: claude mcp add --transport http ontos <adresa>, pak /mcp › Authenticate. Přihlaste se a na obrazovce Připojit zvolte firmu, Za mě a Navrhovat změny ke schválení.',
          id: 'akros-mcp-souhlas',
          persona: expedice,
          say: 'Člověk sám zvolí firmu, za koho aplikace jedná, k jakým modulům má přístup a jestli změny jen navrhuje ke schválení.',
          target: { kind: 'app', path: '/profil' },
          title: 'Souhlas v češtině',
        },
        {
          click: 'U připojení Upravit přístup: zúžit moduly nebo přepnout na Jen čtení. Potom Odpojit.',
          id: 'akros-mcp-upravit',
          persona: expedice,
          say: 'Přístup jde kdykoli zúžit nebo odebrat bez nového přihlášení. Aplikace ztratí přístup hned při dalším požadavku.',
          target: { kind: 'app', path: '/profil' },
          title: 'Upravit nebo odpojit',
        },
        {
          click: 'Nastavení › Připojené aplikace: dlaždice, filtry a u připojení Odpojit s důvodem.',
          id: 'akros-mcp-prehled',
          persona: eshop,
          say: 'Správce vidí všechna připojení ve firmě a jedním kliknutím je odpojí. Odpojení i důvod se zapíšou do auditu.',
          target: { kind: 'app', path: '/sprava/pripojene-aplikace' },
          title: 'Přehled připojení pro správce',
        },
      ],
      summary:
        'ChatGPT nebo Claude se připojí jednou adresou, přihlášením do OntOS a souhlasem, bez kopírování tokenů.',
      title: 'Připojení ChatGPT / Claude',
    },
  ],
  boundaries: {
    live: [
      'Katalog, varianty, ceny, dostupnost a vyhledávání e-shopu AKROS čte server e-shopu přímo z OntOS; klíč k OntOS nikdy nepřijde do prohlížeče.',
      'Objednávka se skutečně uloží do OntOS, sníží sklad varianty a vidí ji správce i expedice; zákazník sleduje stav ve svém účtu.',
      'Změna ceny, textu nebo obrázku v administraci se v e-shopu projeví po obnovení stránky (krátká cache).',
      'Přihlášení a registrace používají zákaznický účet napojený na OntOS. Pokladna vyžaduje přihlášení před zadáním dopravy a adresy.',
    ],
    simulated: [
      'Volba PPL nebo České pošty se s aktuální cenou uloží do objednávky; sama nezarezervuje přepravu ani nevytvoří štítek.',
      'Objednávka bez online platby: v pokladně není platební brána a odesláním se nic neplatí.',
      'Objednávka i zákaznické údaje se skutečně ukládají; používejte účet a kontakty určené pro ukázku.',
      'Doručení e-mailů závisí na nastavení prostředí. Při ukázce neslibujte doručení do skutečné schránky ani omezení jen na lokální Mailpit.',
    ],
    unfinished: [
      'Množstevní cenové úrovně (nižší cena od 100 nebo 500 ks) zdrojová data nemají, e-shop je proto nenabízí.',
      'Produkt nejde smazat, jen vyřadit z prodeje (neaktivní a nezveřejněný).',
      'Odkaz v průvodci používá e-shop daného prostředí: na stage veřejný stage e-shop, při místním spuštění localhost.',
      'Daňové a účetní doklady, napojení dopravců, platební brány a kupóny nejsou součástí této verze.',
    ],
  },
  companyName: 'AKROS',
  id: 'akros',
  intro:
    'Zákaznický e-shop AKROS napojený na OntOS: nákup konkrétní varianty, změna ceny v administraci a zpracování objednávky expedicí.',
  legalEntityId: '71000000-0000-4000-8000-000000000024',
};
