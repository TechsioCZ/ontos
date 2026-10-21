import type { DemoGuide, DemoGuidePersona } from '../demo-guide-types.ts';

const management: DemoGuidePersona = { email: 'management@siampark.demo', role: 'Vedení' };
const operations: DemoGuidePersona = { email: 'operations@siampark.demo', role: 'Provoz' };
const finance: DemoGuidePersona = { email: 'finance@siampark.demo', role: 'Účetní' };
const external: DemoGuidePersona = { email: 'external@siampark.demo', role: 'Externí obchodník' };

export const siamparkGuide: DemoGuide = {
  chapters: [
    {
      id: 'uvod',
      steps: [
        {
          click: 'Otevřete Domů a dole v menu ukažte tenant OntOS DEMO a vybranou firmu Siampark.',
          id: 'siampark-uvod',
          persona: management,
          say: 'OntOS je jedna platforma pro více firem, ale každá firma má oddělená data a oprávnění. Začneme u konkrétní budovy a dojdeme až k faktuře.',
          target: { kind: 'app', path: '/' },
          title: 'Jedna platforma, oddělené firmy',
        },
      ],
      summary: 'Co ukážeme: více firem na jedné platformě s oddělenými daty.',
      title: 'Úvod',
    },
    {
      id: 'nemovitosti',
      steps: [
        {
          click: 'Nadpis Portfolio nemovitostí → odkaz Riverside Office Park →.',
          id: 'siampark-portfolio',
          persona: management,
          say: 'Z přehledu portfolia se jedním kliknutím dostanu ke konkrétní budově.',
          target: { kind: 'app', path: '/nemovitosti/prehled' },
          title: 'Portfolio nemovitostí',
        },
        {
          click: 'Počkejte na načtení a odrolujte pod seznamy k titulku RIVERSIDE · Riverside Office Park.',
          id: 'siampark-budova',
          persona: management,
          say: 'Budova má vlastní kartu s jednotkami a jejich obsazeností.',
          target: { kind: 'app', path: '/nemovitosti?resourceId=6a0197b3-4b13-46c5-a3ab-8dbb46dda58e' },
          title: 'Budova Riverside Office Park',
        },
        {
          click: 'Odrolujte k R101 · Obchodní prostor R101 a sekci Nájmy a pobyty jednotky.',
          id: 'siampark-r101',
          persona: management,
          say: 'Obsazenost jednotky R101 má dohledatelný nájem, nejde o samostatně přepisovanou tabulku.',
          target: { kind: 'app', path: '/nemovitosti?resourceId=bf65f06e-fe64-4787-813f-6a62bad12409' },
          title: 'Jednotka R101',
        },
        {
          click: 'Níže na stránce sekce Kontaktní osoby a historie vztahu.',
          id: 'siampark-najem',
          persona: management,
          say: 'Nájem nese nájemce, jeho kontaktní osoby i historii vztahu na jednom místě.',
          target: { kind: 'app', path: '/najmy?resourceId=d2197c66-25a6-5113-86bf-14cb3c3c1b3e' },
          title: 'Nájem a kontaktní osoby',
        },
        {
          click: 'Sekce Obchodní podmínky.',
          id: 'siampark-smlouva',
          persona: management,
          say: 'Smlouva je propojená s nájmem i jednotkou a obchodní podmínky jsou uložené přímo u ní.',
          target: { kind: 'app', path: '/smlouvy?resourceId=a0ac0359-d251-5b37-bed2-b9a0db201a77' },
          title: 'Smlouva k nájmu',
        },
        {
          click: 'Sekce Úhrady. Tato faktura je zatím koncept bez úhrad.',
          id: 'siampark-faktura',
          persona: management,
          say: 'Jednotka, nájemce, smlouva a doklad jsou propojené. Ukazujeme skutečně uloženou evidenci, ne slib napojení banky nebo podpisové služby.',
          target: { kind: 'app', path: '/finance?resourceId=23e891be-5ab3-462c-84fd-d628605a068b' },
          title: 'Navázaná faktura',
        },
      ],
      summary: 'Jedna jednotka a všechno, co k ní patří, je propojené.',
      title: 'Budova → nájem → smlouva → faktura',
    },
    {
      id: 'provoz',
      steps: [
        {
          click: 'Ukažte přehled → odkaz Měřidla a energie.',
          id: 'siampark-provoz-prehled',
          persona: operations,
          say: 'Stejné prostředí řeší i každodenní provoz: odečty, dokumenty a odpovědnost za práci.',
          target: { kind: 'app', path: '/provoz/prehled' },
          title: 'Přehled provozu',
        },
        {
          click: 'První řádek měřidla → detail a historie odečtů.',
          id: 'siampark-meridla',
          persona: operations,
          say: 'Spotřeba má vlastní historii odečtů. Chybějící podklad není automaticky nulový náklad.',
          target: { kind: 'app', path: '/provoz/meridla' },
          title: 'Měřidla a odečty',
        },
        {
          click: 'První řádek → detail dokumentu, verze a přiřazení.',
          id: 'siampark-dokumenty',
          persona: operations,
          say: 'Dokumenty mají verze a jsou přiřazené ke konkrétní práci nebo jednotce.',
          target: { kind: 'app', path: '/provoz/dokumenty' },
          title: 'Dokumenty a verze',
        },
        {
          click: 'Záložka Revize a servis.',
          id: 'siampark-majetek',
          persona: management,
          say: 'Aktuální revize má příští termín, technika i odpovědnou osobu. Starší záznam nemažeme a závady nezamlčujeme.',
          target: { kind: 'app', path: '/provoz/majetek?asset=siampark-asset-002' },
          title: 'Majetek a revize',
        },
      ],
      summary: 'Odečty energií, dokumenty a majetek ve stejném prostředí.',
      title: 'Provoz areálu',
    },
    {
      id: 'finance',
      steps: [
        {
          click:
            'Otevře se faktura FV-2026-0007: sekce Úhrady, pod ní Upomínky. Nic nového neúčtujte ani neodesílejte.',
          id: 'siampark-castecna-uhrada',
          persona: finance,
          say: 'Finance vidí doklad, evidovanou částečnou platbu i upomínky skutečně odeslané e-mailem; řádek SIMULACE je starší záznam z doby před napojením e-mailu. Platba je ruční evidence, ne napojení na banku.',
          target: { kind: 'app', path: '/finance?resourceId=c9f16710-c669-43ca-91d6-8e9f0bd70a4b' },
          title: 'Částečná úhrada a upomínky',
        },
        {
          click: 'Záložka Historie, potom Odpisy.',
          id: 'siampark-odpisy',
          persona: finance,
          say: 'Přecenění Rezidence Parková ze 48,5 na 61,2 mil. Kč zachovalo původní částku, důvod (znalecký posudek ZP-214/2025) i autora. Účetní a daňové odpisy vedeme odděleně jako schválenou evidenci.',
          target: { kind: 'app', path: '/provoz/majetek?asset=siampark-asset-001' },
          title: 'Hodnota a odpisy majetku',
        },
      ],
      summary: 'Účetní má vlastní pracovní pohled na doklady a majetek.',
      title: 'Finance',
    },
    {
      id: 'externista',
      steps: [
        {
          click:
            'Otevřete Kavárnu Na Nábřeží s.r.o. a ukažte Obchodník: Martin Krejčí, externí obchodník, kterému Vedení kontakt svěřilo.',
          id: 'siampark-vedeni-sveruje',
          persona: management,
          say: 'Vedení vidí všechny zájemce o pronájem a vybrané svěří externímu obchodníkovi. Svěření je záznam s autorem a důvodem.',
          target: { kind: 'app', path: '/crm/klienti' },
          title: 'Vedení svěřuje kontakty',
        },
        {
          click:
            'Seznam Klienti: jen tři svěření zájemci a štítek Vidíte pouze klienty přidělené vám. Otevřete jednoho z nich.',
          id: 'siampark-externista-klienti',
          persona: external,
          say: 'Externí obchodník čte jen svěřené kontakty a jejich jednání. Ostatní zájemce ani finance nevidí a hlídá to server, ne skryté menu.',
          target: { kind: 'app', path: '/crm/klienti' },
          title: 'Jen svěřené kontakty',
        },
        {
          click:
            'Prodej › Příležitosti: jen tři svěřené obchodní případy (Kavárna Na Nábřeží, Horák & partneři, Ing. Šťastný), bez tlačítek pro změny. Otevřete jeden případ.',
          id: 'siampark-externista-pripady',
          persona: external,
          say: 'Stejně tak obchodní případy: server vrátí jen případy, které mu Vedení svěřilo. Ordinaci Fyzioterapie Pohyb ani Lékárnu nevidí a nic nezmění.',
          target: { kind: 'app', path: '/prodej/prilezitosti' },
          title: 'Jen svěřené obchodní případy',
        },
        {
          click: 'Najděte úkol Předání nájemního prostoru R101 a ukažte omezené menu.',
          id: 'siampark-externista-prace',
          persona: external,
          say: 'Externista může řešit svoji práci, ale neprochází finance firmy.',
          target: { kind: 'app', path: '/ukoly' },
          title: 'Externista vidí svou práci',
        },
        {
          click:
            'Provoz › Agenda: jen událost Prohlídka R101 se zájemcem, kterou mu Siampark přidělil, a poznámka Agendu máte jen pro čtení. Bez tlačítka Nová událost; v Měřidlech jen odečty bez cen a bez úprav.',
          id: 'siampark-externista-provoz',
          persona: external,
          say: 'Z provozu dostane jen to, co mu Siampark přidělil. Události kolegů ani ceny energií neuvidí a nic nezmění – hlídá to server.',
          target: { kind: 'app', path: '/provoz/agenda' },
          title: 'Provoz jen pro čtení',
        },
        {
          click: 'Otevřete odkaz přímo: zobrazí se české odmítnutí přístupu bez faktur a částek.',
          id: 'siampark-externista-zakaz',
          persona: external,
          say: 'Nestačí skrýt položku v menu: omezení platí i při přímém otevření adresy.',
          target: { kind: 'app', path: '/finance' },
          title: 'Přímý odkaz na finance',
        },
      ],
      summary: 'Externí obchodník dostane svěřené kontakty, svěřené obchodní případy a svou práci, ne účetnictví.',
      title: 'Externista a oprávnění',
    },
    {
      id: 'pripojeni-ai',
      steps: [
        {
          click: 'Menu účtu › Můj profil › Připojené aplikace › Jak připojit › Kopírovat adresu.',
          id: 'siampark-mcp-adresa',
          persona: operations,
          say: 'Do ChatGPT nebo Claude se vkládá jen adresa serveru, žádný klíč ani token. Přihlášení a souhlas proběhnou v OntOS.',
          target: { kind: 'app', path: '/profil' },
          title: 'Jedna adresa pro ChatGPT i Claude',
        },
        {
          click:
            'V Claude Code: claude mcp add --transport http ontos <adresa>, pak /mcp › Authenticate. Přihlaste se a na obrazovce Připojit zvolte firmu, Za mě a Navrhovat změny ke schválení.',
          id: 'siampark-mcp-souhlas',
          persona: operations,
          say: 'Člověk sám zvolí firmu, za koho aplikace jedná, k jakým modulům má přístup a jestli změny jen navrhuje ke schválení.',
          target: { kind: 'app', path: '/profil' },
          title: 'Souhlas v češtině',
        },
        {
          click: 'U připojení Upravit přístup: zúžit moduly nebo přepnout na Jen čtení. Potom Odpojit.',
          id: 'siampark-mcp-upravit',
          persona: operations,
          say: 'Přístup jde kdykoli zúžit nebo odebrat bez nového přihlášení. Aplikace ztratí přístup hned při dalším požadavku.',
          target: { kind: 'app', path: '/profil' },
          title: 'Upravit nebo odpojit',
        },
        {
          click: 'Nastavení › Připojené aplikace: dlaždice, filtry a u připojení Odpojit s důvodem.',
          id: 'siampark-mcp-prehled',
          persona: management,
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
  companyName: 'Siampark',
  id: 'siampark',
  intro:
    'Správa areálu od budovy přes nájem a smlouvu až po fakturu, provoz, finance a externího dodavatele. Každá role vidí jen to, co potřebuje.',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
};
