import type { DemoGuide, DemoGuidePersona } from '../demo-guide-types.ts';

const spravce: DemoGuidePersona = { email: 'spravce@hanak.demo', role: 'Správce' };
const vedouci: DemoGuidePersona = { email: 'vedouci@hanak.demo', role: 'Vedení obchodu' };
const jan: DemoGuidePersona = { email: 'obchodnik.a@hanak.demo', role: 'Obchodník Jan' };
const petra: DemoGuidePersona = { email: 'obchodnik.b@hanak.demo', role: 'Obchodnice Petra' };

export const hanakGuide: DemoGuide = {
  chapters: [
    {
      id: 'obchodnik',
      steps: [
        {
          click: 'Ukažte nadpis Mí klienti a seznam vlastních klientů.',
          id: 'hanak-moji-klienti',
          persona: jan,
          say: 'Obchodník má svoje klienty, jejich vztahovou historii a další krok na jednom místě.',
          target: { kind: 'app', path: '/crm/klienti' },
          title: 'Mí klienti',
        },
        {
          click: 'Řádek Pekárna Malá s.r.o. → karta klienta → kontakty, návštěvy a objednávky. Nic nepřepisujte.',
          id: 'hanak-karta-klienta',
          persona: jan,
          say: 'Na kartě klienta jsou kontakty, návštěvy i objednávky, takže obchodník přijde na schůzku připravený.',
          target: { kind: 'app', path: '/crm/klienti' },
          title: 'Karta klienta Pekárna Malá',
        },
        {
          click: 'Ukažte seznam dalších oslovení a termínů.',
          id: 'hanak-k-osloveni',
          persona: jan,
          say: 'Plán oslovení hlídá další krok a termín, aby žádný klient nezapadl.',
          target: { kind: 'app', path: '/crm/k-osloveni' },
          title: 'Koho oslovit dál',
        },
        {
          click: 'Ukažte seznam návštěv a otevřete jednu z nich.',
          id: 'hanak-navstevy',
          persona: jan,
          say: 'Každá návštěva má datum, výsledek a navazující krok.',
          target: { kind: 'app', path: '/crm/navstevy' },
          title: 'Návštěvy u klientů',
        },
        {
          click: 'Přihlaste se jako Petra a porovnejte seznam se seznamem Jana.',
          id: 'hanak-kolegyne',
          persona: petra,
          say: 'Petra vidí jen svoje klienty. Klienty kolegy nedostane ani tehdy, když zná odkaz.',
          target: { kind: 'app', path: '/crm/klienti' },
          title: 'Klienti kolegyně jsou oddělení',
        },
      ],
      summary: 'Obchodník Jan pracuje jen se svými klienty a ví, koho oslovit dál.',
      title: 'Obchodník a jeho klienti',
    },
    {
      id: 'vedeni',
      steps: [
        {
          click:
            'Šablona a vzorové soubory → Otevřít v importu u Úvodního importu → ukažte 29 duplicit → Zrušit. Nic nepotvrzujte.',
          id: 'hanak-import-nahled',
          persona: vedouci,
          say: 'Před uložením je vidět kontrola každého řádku. Opakované načtení nezaloží druhé objednávky ani duplicitní události.',
          target: { kind: 'app', path: '/crm/importy' },
          title: 'Import objednávek z CSV',
        },
        {
          click: 'Historie importů → 04-rijmove-objednavky.csv.',
          id: 'hanak-import-historie',
          persona: vedouci,
          say: 'Platné řádky se uložily a chybné zůstaly čitelně dohledatelné v historii dávky.',
          target: { kind: 'app', path: '/crm/importy' },
          title: 'Historie importů',
        },
        {
          click: 'Otevřete OBJ-2026-0277 ve frontě a zavřete bez uložení.',
          id: 'hanak-parovani',
          persona: vedouci,
          say: 'Podobný název nebo e-mail je jen kandidát. Přiřazení potvrzuje člověk s důvodem a historií.',
          target: { kind: 'app', path: '/crm/parovani' },
          title: 'Párování objednávek s klienty',
        },
        {
          click: 'EUR u grafu → níže Export objednávek (CSV).',
          id: 'hanak-prehled-prodeju',
          persona: vedouci,
          say: 'Vedení dostává souhrn nad zdrojovými objednávkami a koruny s eury nemíchá. Přepínač EUR mění graf, ne celou tabulku ani export.',
          target: { kind: 'app', path: '/crm/prehled-prodeju' },
          title: 'Přehled prodejů v CZK a EUR',
        },
      ],
      summary: 'Vedení načítá objednávky z CSV, páruje je s klienty a sleduje prodeje.',
      title: 'Vedení: importy a přehled prodejů',
    },
    {
      id: 'bezpecnost',
      steps: [
        {
          click: 'Ukažte vysvětlení oprávnění místo tlačítek pro import a celofiremní vzory.',
          id: 'hanak-obchodnik-importy',
          persona: jan,
          say: 'Obchodník vidí jen své objednávky. Import a celofiremní vzory chrání i server, nejen skryté tlačítko.',
          target: { kind: 'app', path: '/crm/importy' },
          title: 'Obchodník bez celofiremních importů',
        },
        {
          click:
            'Otevřete odkaz přímo: zobrazí se Tato agenda není přístupná. Dole ve výběru firmy je jen Velkoobchod Hanák s.r.o.',
          id: 'hanak-izolace-firem',
          persona: vedouci,
          say: 'Stejná platforma neznamená společná data: tímto odkazem se vedení Hanáka k objednávkám jiné firmy nedostane.',
          target: { kind: 'app', path: '/prodej/objednavky' },
          title: 'Cizí agenda není přístupná',
        },
      ],
      summary: 'Role i firma omezují, co kdo uvidí, a to i při přímém odkazu.',
      title: 'Oddělená data a role',
    },
    {
      id: 'ai',
      steps: [
        {
          click: 'Otevřete Nastavení › Ke schválení.',
          id: 'hanak-ai-urovne',
          persona: vedouci,
          say: 'Úroveň A jen čte, B smí navíc založit úkol a C navrhuje změny dat klientů. Každá úroveň je samostatná identita s vlastními oprávněními.',
          target: { kind: 'app', path: '/sprava/ke-schvaleni' },
          title: 'Tři úrovně AI agenta',
        },
        {
          click:
            'Obnovit seznam → dávka „Ověření kontaktů Bistra Král po dnešní schůzce“ (2 změny) → ukažte telefon a web před a po. Starší dávku s přidělením klienta neschvalujte. Když dávka chybí, technik ji připraví příkazem node scripts/demo/prepare-ai-c-batch.mts.',
          id: 'hanak-ai-navrh',
          persona: vedouci,
          say: 'AI agent úrovně C poslal přes MCP konkrétní návrh. Dokud ho člověk neschválí, data klienta se nemění.',
          target: { kind: 'app', path: '/sprava/ke-schvaleni' },
          title: 'Návrh AI čeká na člověka',
        },
        {
          click:
            'V dávce Bistra Král: u webu Zamítnout změnu → u telefonu Schválit změnu → Všechny dávky. Pak obnovte stránku.',
          id: 'hanak-ai-rozhodnuti',
          persona: vedouci,
          say: 'Člověk rozhoduje po jednotlivých změnách a deník rozhodnutí zůstane i po obnovení stránky.',
          target: { kind: 'app', path: '/sprava/ke-schvaleni' },
          title: 'Schválit jednu změnu, zamítnout druhou',
        },
        {
          click:
            'U dávky Bistra Král Vrátit vše → Potvrdit vrácení celé dávky → ověřte původní telefon. Před další ukázkou připraví technik novou dávku.',
          id: 'hanak-ai-vraceni',
          persona: vedouci,
          say: 'Změny AI jde hromadně vrátit a vrácení se trvale zapíše. AI tedy není cesta kolem oprávnění ani kolem historie.',
          target: { kind: 'app', path: '/sprava/ke-schvaleni' },
          title: 'Vrátit celou dávku',
        },
        {
          click: 'Otevřete Nastavení › Aktivita agentů a ve filtru Agent vyberte AI agenta C.',
          id: 'hanak-ai-audit',
          persona: vedouci,
          say: 'Čtení, zápisy, odmítnutí i návrhy AI agentů ze všech modulů jsou v jednom auditu.',
          target: { kind: 'app', path: '/sprava/aktivita-agentu' },
          title: 'Audit aktivit AI',
        },
      ],
      summary: 'Tři úrovně AI s vlastními oprávněními; změny úrovně C schvaluje člověk.',
      title: 'AI agent A / B / C',
    },
    {
      id: 'pripojeni-ai',
      steps: [
        {
          click: 'Menu účtu › Můj profil › Připojené aplikace › Jak připojit › Kopírovat adresu.',
          id: 'hanak-mcp-adresa',
          persona: jan,
          say: 'Do ChatGPT nebo Claude se vkládá jen adresa serveru, žádný klíč ani token. Přihlášení a souhlas proběhnou v OntOS.',
          target: { kind: 'app', path: '/profil' },
          title: 'Jedna adresa pro ChatGPT i Claude',
        },
        {
          click:
            'V Claude Code: claude mcp add --transport http ontos <adresa>, pak /mcp › Authenticate. Přihlaste se a na obrazovce Připojit zvolte firmu, Za mě a Navrhovat změny ke schválení.',
          id: 'hanak-mcp-souhlas',
          persona: jan,
          say: 'Člověk sám zvolí firmu, za koho aplikace jedná, k jakým modulům má přístup a jestli změny jen navrhuje ke schválení.',
          target: { kind: 'app', path: '/profil' },
          title: 'Souhlas v češtině',
        },
        {
          click: 'U připojení Upravit přístup: zúžit moduly nebo přepnout na Jen čtení. Potom Odpojit.',
          id: 'hanak-mcp-upravit',
          persona: jan,
          say: 'Přístup jde kdykoli zúžit nebo odebrat bez nového přihlášení. Aplikace ztratí přístup hned při dalším požadavku.',
          target: { kind: 'app', path: '/profil' },
          title: 'Upravit nebo odpojit',
        },
        {
          click:
            'Nastavení › Lidé a role › Agenti a jejich připojení › Kdo smí agenta připojit: vyberte člověka a Uložit.',
          id: 'hanak-mcp-agent',
          persona: spravce,
          say: 'Agenta připojí jen člověk, kterému to správce povolí. Změny se zapíšou jako agent s poznámkou, kdo ho připojil.',
          target: { kind: 'app', path: '/sprava/lide' },
          title: 'Kdo smí připojit agenta',
        },
        {
          click: 'Nastavení › Připojené aplikace: dlaždice, filtry a u připojení Odpojit s důvodem.',
          id: 'hanak-mcp-prehled',
          persona: spravce,
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
  companyName: 'Velkoobchod Hanák s.r.o.',
  id: 'hanak',
  intro:
    'Obchodní tým velkoobchodu: obchodník a jeho klienti, vedení s importy a přehledem prodejů a AI agent, jehož změny schvaluje člověk.',
  legalEntityId: '71000000-0000-4000-8000-000000000022',
};
